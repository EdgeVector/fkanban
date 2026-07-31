/** Canonical LastDB runtime API route strings used by the SDK. */
export const LASTDB_API_ROUTES = {
    requestConsent: '/api/apps/request-consent',
    consentStatus: (requestId) => `/api/apps/consent-status/${encodeURIComponent(requestId)}`,
    query: '/api/query',
    mutation: '/api/mutation',
    appSearch: '/api/app/search',
    appChanges: '/api/app/changes',
    autoIdentity: '/api/system/auto-identity',
    schemas: '/api/schemas',
};
/** SDK routes that must stay present in the Rust UDS data router. */
export const LASTDB_UDS_SHARED_ROUTES = [
    ['POST', LASTDB_API_ROUTES.query],
    ['POST', LASTDB_API_ROUTES.mutation],
    ['POST', LASTDB_API_ROUTES.appSearch],
    ['POST', LASTDB_API_ROUTES.appChanges],
    ['GET', LASTDB_API_ROUTES.schemas],
    ['GET', LASTDB_API_ROUTES.autoIdentity],
];
//# sourceMappingURL=apiRoutes.js.map