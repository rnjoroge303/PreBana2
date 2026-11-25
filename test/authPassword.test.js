const assert = require("node:assert/strict");
const test = require("node:test");
const authController = require("../src/controllers/authController");

test("staff account creation rejects passwords shorter than eight bytes", async () => {
    const response = {
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };

    await authController.createStaffAccount({
        body: {
            email: "staff@example.com",
            password: "short77",
            confirmPassword: "short77"
        }
    }, response, (error) => { throw error; });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /8/);
});
