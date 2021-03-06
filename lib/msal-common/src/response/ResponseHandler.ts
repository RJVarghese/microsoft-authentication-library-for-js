/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import { ServerAuthorizationTokenResponse } from "../server/ServerAuthorizationTokenResponse";
import { buildClientInfo, ClientInfo } from "../account/ClientInfo";
import { ICrypto } from "../crypto/ICrypto";
import { ClientAuthError } from "../error/ClientAuthError";
import { StringUtils } from "../utils/StringUtils";
import { ServerAuthorizationCodeResponse } from "../server/ServerAuthorizationCodeResponse";
import { Logger } from "../logger/Logger";
import { ServerError } from "../error/ServerError";
import { IdToken } from "../account/IdToken";
import { UnifiedCacheManager } from "../unifiedCache/UnifiedCacheManager";
import { ScopeSet } from "../request/ScopeSet";
import { TimeUtils } from "../utils/TimeUtils";
import { AuthenticationResult } from "./AuthenticationResult";
import { AccountEntity } from "../unifiedCache/entities/AccountEntity";
import { Authority } from "../authority/Authority";
import { AuthorityType } from "../authority/AuthorityType";
import { IdTokenEntity } from "../unifiedCache/entities/IdTokenEntity";
import { AccessTokenEntity } from "../unifiedCache/entities/AccessTokenEntity";
import { RefreshTokenEntity } from "../unifiedCache/entities/RefreshTokenEntity";
import { InteractionRequiredAuthError } from "../error/InteractionRequiredAuthError";
import { CacheRecord } from "../unifiedCache/entities/CacheRecord";

/**
 * Class that handles response parsing.
 */
export class ResponseHandler {
    private clientId: string;
    private uCacheManager: UnifiedCacheManager;
    private cryptoObj: ICrypto;
    private logger: Logger;
    private clientInfo: ClientInfo;
    private homeAccountIdentifier: string;

    constructor(clientId: string, unifiedCacheManager: UnifiedCacheManager, cryptoObj: ICrypto, logger: Logger) {
        this.clientId = clientId;
        this.uCacheManager = unifiedCacheManager;
        this.cryptoObj = cryptoObj;
        this.logger = logger;
    }

    /**
     * Function which validates server authorization code response.
     * @param serverResponseHash
     * @param cachedState
     * @param cryptoObj
     */
    validateServerAuthorizationCodeResponse(
        serverResponseHash: ServerAuthorizationCodeResponse,
        cachedState: string,
        cryptoObj: ICrypto
    ): void {
        if (serverResponseHash.state !== cachedState) {
            throw ClientAuthError.createStateMismatchError();
        }

        // Check for error
        if (serverResponseHash.error || serverResponseHash.error_description || serverResponseHash.suberror) {
            if (InteractionRequiredAuthError.isInteractionRequiredError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror)) {
                throw new InteractionRequiredAuthError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror);
            }

            throw new ServerError(serverResponseHash.error, serverResponseHash.error_description, serverResponseHash.suberror);
        }

        if (serverResponseHash.client_info) {
            buildClientInfo(serverResponseHash.client_info, cryptoObj);
        }
    }

    /**
     * Function which validates server authorization token response.
     * @param serverResponse
     */
    validateTokenResponse(
        serverResponse: ServerAuthorizationTokenResponse
    ): void {
        // Check for error
        if (serverResponse.error || serverResponse.error_description || serverResponse.suberror) {
            if (InteractionRequiredAuthError.isInteractionRequiredError(serverResponse.error, serverResponse.error_description, serverResponse.suberror)) {
                throw new InteractionRequiredAuthError(serverResponse.error, serverResponse.error_description, serverResponse.suberror);
            }

            const errString = `${serverResponse.error_codes} - [${serverResponse.timestamp}]: ${serverResponse.error_description} - Correlation ID: ${serverResponse.correlation_id} - Trace ID: ${serverResponse.trace_id}`;
            throw new ServerError(serverResponse.error, errString);
        }

        // generate homeAccountId
        if (serverResponse.client_info) {
            this.clientInfo = buildClientInfo(serverResponse.client_info, this.cryptoObj);
            if (!StringUtils.isEmpty(this.clientInfo.uid) && !StringUtils.isEmpty(this.clientInfo.utid)) {
                this.homeAccountIdentifier = this.cryptoObj.base64Encode(this.clientInfo.uid) + "." + this.cryptoObj.base64Encode(this.clientInfo.utid);
            }
        }
    }

    /**
     * Returns a constructed token response based on given string. Also manages the cache updates and cleanups.
     * @param serverTokenResponse
     * @param authority
     */
    generateAuthenticationResult(serverTokenResponse: ServerAuthorizationTokenResponse, authority: Authority): AuthenticationResult {

        // create an idToken object (not entity)
        const idTokenObj = new IdToken(serverTokenResponse.id_token, this.cryptoObj);

        // save the response tokens
        const cacheRecord = this.generateCacheRecord(serverTokenResponse, idTokenObj, authority);
        this.uCacheManager.saveCacheRecord(cacheRecord);

        // Expiration calculation
        const expiresInSeconds = TimeUtils.nowSeconds() + serverTokenResponse.expires_in;
        const extendedExpiresInSeconds = expiresInSeconds + serverTokenResponse.ext_expires_in;

        const responseScopes = ScopeSet.fromString(serverTokenResponse.scope, this.clientId, true);

        const authenticationResult: AuthenticationResult = {
            uniqueId: idTokenObj.claims.oid || idTokenObj.claims.sub,
            tenantId: idTokenObj.claims.tid,
            scopes: responseScopes.asArray(),
            idToken: idTokenObj.rawIdToken,
            idTokenClaims: idTokenObj.claims,
            accessToken: serverTokenResponse.access_token,
            expiresOn: new Date(expiresInSeconds),
            extExpiresOn: new Date(extendedExpiresInSeconds),
            familyId: serverTokenResponse.foci || null,
        };

        return authenticationResult;
    }

    /**
     * Generate Account
     * @param serverTokenResponse
     * @param idToken
     * @param authority
     */
    generateAccountEntity(serverTokenResponse: ServerAuthorizationTokenResponse, idToken: IdToken, authority: Authority): AccountEntity {
        const authorityType = authority.authorityType;

        if (!serverTokenResponse.client_info)
            throw ClientAuthError.createClientInfoEmptyError(serverTokenResponse.client_info);

        switch (authorityType) {
            case AuthorityType.B2C:
                return AccountEntity.createAccount(serverTokenResponse.client_info, authority, idToken, "policy", this.cryptoObj);
            case AuthorityType.Adfs:
                return AccountEntity.createADFSAccount(authority, idToken);
            // default to AAD
            default:
                return AccountEntity.createAccount(serverTokenResponse.client_info, authority, idToken, null, this.cryptoObj);
        }
    }

    /**
     * Generates CacheRecord
     * @param serverTokenResponse
     * @param idTokenObj
     * @param authority
     */
    generateCacheRecord(serverTokenResponse: ServerAuthorizationTokenResponse, idTokenObj: IdToken, authority: Authority): CacheRecord {

        const cacheRecord = new CacheRecord();

        // Account
        cacheRecord.account  = this.generateAccountEntity(
            serverTokenResponse,
            idTokenObj,
            authority
        );

        // IdToken
        cacheRecord.idToken = IdTokenEntity.createIdTokenEntity(
            this.homeAccountIdentifier,
            authority.canonicalAuthorityUrlComponents.HostNameAndPort,
            serverTokenResponse.id_token,
            this.clientId,
            idTokenObj.claims.tid
        );

        // AccessToken
        const responseScopes = ScopeSet.fromString(serverTokenResponse.scope, this.clientId, true);
        cacheRecord.accessToken = AccessTokenEntity.createAccessTokenEntity(
            this.homeAccountIdentifier,
            authority.canonicalAuthorityUrlComponents.HostNameAndPort,
            serverTokenResponse.access_token,
            this.clientId,
            idTokenObj.claims.tid,
            responseScopes.asArray().join(" "),
            serverTokenResponse.expires_in,
            serverTokenResponse.ext_expires_in
        );

        // refreshToken
        cacheRecord.refreshToken = RefreshTokenEntity.createRefreshTokenEntity(
            this.homeAccountIdentifier,
            authority.canonicalAuthorityUrlComponents.HostNameAndPort,
            serverTokenResponse.refresh_token,
            this.clientId,
            serverTokenResponse.foci
        );

        return cacheRecord;
    }
}
