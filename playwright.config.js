const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests",
    fullyParallel: false,
    reporter: "list",
    use: {
        baseURL: "http://127.0.0.1:8081",
        permissions: ["clipboard-read", "clipboard-write"],
        trace: "on-first-retry",
    },
    webServer: {
        command: "HTTP_ADDR=:8081 go run .",
        url: "http://127.0.0.1:8081/healthz",
        reuseExistingServer: false,
        timeout: 120000,
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
});
