const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
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

        test("staff can access staff-enabled routes but not administrator-only routes", () => {
            const authPath = require.resolve("../src/middleware/auth");
            const previousAuthModule = require.cache[authPath];
            const previousJwtSecret = process.env.JWT_SECRET;
            const secret = "test-only-staff-jwt-secret";
            process.env.JWT_SECRET = secret;
            delete require.cache[authPath];

            try {
                const { requireRole } = require(authPath);
                const token = jwt.sign({ email: "staff@example.com", role: "staff" }, secret, {
                    subject: "staff-id",
                    issuer: "prebana-store"
                });
                const request = {
                    headers: { cookie: `prebana_staff_token=${encodeURIComponent(token)}`, accept: "application/json" },
                    get(name) {
                        return this.headers[name.toLowerCase()];
                    }
                };
                const response = {
                    locals: {},
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
                };

                requireRole(["admin", "staff"])(request, response, () => {
                    assert.deepEqual(request.authUser, {
                        id: "staff-id",
                        email: "staff@example.com",
                        role: "staff"
                    });
                });
                assert.equal(response.statusCode, undefined);

                requireRole("admin")(request, response, () => {
                    assert.fail("Staff must not continue through admin-only routes.");
                });
                assert.equal(response.statusCode, 401);
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
