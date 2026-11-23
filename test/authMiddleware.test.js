const assert = require("node:assert/strict");
const test = require("node:test");

test("requireRole returns JSON for unauthenticated JSON requests and redirects HTML requests", () => {
    const authPath = require.resolve("../src/middleware/auth");
    const previousAuthModule = require.cache[authPath];
    const previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "test-only-jwt-secret";
    delete require.cache[authPath];

    try {
        const { requireRole } = require(authPath);
        const middleware = requireRole("client");
        const createResponse = () => ({
            clearCookie() {
                return this;
            },
            status(statusCode) {
                this.statusCode = statusCode;
                return this;
            },
            json(body) {
                this.body = body;
                return this;
            },
            redirect(url) {
                this.redirectUrl = url;
                return this;
            }
        });
        const createRequest = (accept) => ({
            headers: { accept },
            get(name) {
                return this.headers[name.toLowerCase()];
            }
        });

        const jsonResponse = createResponse();
        middleware(createRequest("application/json"), jsonResponse, () => {
            assert.fail("Unauthenticated request must not continue.");
        });
        assert.equal(jsonResponse.statusCode, 401);
        assert.deepEqual(jsonResponse.body, { error: "Your session has expired. Please sign in again." });
        assert.equal(jsonResponse.redirectUrl, undefined);

        const htmlResponse = createResponse();
        middleware(createRequest("text/html"), htmlResponse, () => {
            assert.fail("Unauthenticated request must not continue.");
        });
        assert.equal(htmlResponse.redirectUrl, "/pre/client/login");
    } finally {
        delete require.cache[authPath];
        if (previousAuthModule) {
            require.cache[authPath] = previousAuthModule;
        }
        if (previousJwtSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = previousJwtSecret;
        }
    }
});
