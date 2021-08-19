"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const qs = require("qs");

const crypto = require("crypto");
const Json2iob = require("./lib/json2iob");
const axiosCookieJarSupport = require("axios-cookiejar-support").default;
const tough = require("tough-cookie");
class ZehnderCloud extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "zehnder-cloud",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        axiosCookieJarSupport(axios);
        this.cookieJar = new tough.CookieJar();
        this.requestClient = axios.create();
        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.idArray = [];

        this.session = {};
        this.json2iob = new Json2iob(this);

        await this.login();
        if (this.session.id_token) {
            await this.getDeviceList();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, this.session.id_token_expires_in * 1000);
        }
    }
    async login() {
        const [code_verifier, codeChallenge] = this.getCodeChallenge();
        const headers = {
            "User-Agent": "ioBroker 1.0",
        };
        const htmlLoginForm = await this.requestClient({
            method: "get",
            url:
                "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/oauth2/v2.0/authorize?p=B2C_1_signin_signup_enduser&client_id=df77b1ce-c368-4f7f-b0e6-c1406ac6bac9&nonce=" +
                this.randomString(16) +
                "&redirect_uri=https%3A%2F%2Flocalhost%2Fmyweb&scope=openid&response_type=code&prompt=login&code_challenge=" +
                codeChallenge +
                "&code_challenge_method=S256",

            headers: headers,
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
        if (!htmlLoginForm) {
            return;
        }

        const csrf = htmlLoginForm.split('"csrf":"')[1].split('"')[0];
        const state = htmlLoginForm.split("StateProperties=")[1].split('"')[0];
        let data = "request_type=RESPONSE&email=" + encodeURIComponent(this.config.username) + "&password=" + encodeURIComponent(this.config.password);
        headers["X-CSRF-TOKEN"] = csrf;
        await this.requestClient({
            method: "post",
            url: "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/B2C_1_signin_signup_enduser/SelfAsserted?tx=StateProperties=" + state + "&p=B2C_1_signin_signup_enduser",
            headers: headers,
            data: data,
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data;
            })
            .catch((error) => {
                error.response && this.log.error(JSON.stringify(error.response.data));
            });

        const code = await this.requestClient({
            method: "get",
            url:
                "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/B2C_1_signin_signup_enduser/api/CombinedSigninAndSignup/confirmed?rememberMe=false&csrf_token=" +
                csrf +
                "&tx=StateProperties=" +
                state +
                "&p=B2C_1_signin_signup_enduser",
            headers: headers,
            jar: this.cookieJar,
            withCredentials: true,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                return res.data;
            })
            .catch((error) => {
                let code = "";
                if (error.response && error.response.status === 400) {
                    this.log.error(JSON.stringify(error.response.data));
                    return;
                }
                if (error.response && error.response.status === 500) {
                    this.log.info("Please check username and password.");
                }
                if (error.request) {
                    this.log.debug(JSON.stringify(error.request.path));
                    code = qs.parse(error.request.path.split("?")[1]).code;
                    this.log.debug(code);
                    return code;
                }
            });
        data = {
            grant_type: "authorization_code",
            code: code,
            redirect_uri: "https://localhost/myweb",
            scope: "openid",
            code_verifier: code_verifier,
        };

        await this.requestClient({
            method: "post",
            url: "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/B2C_1_signin_signup_enduser/oauth2/v2.0/token",
            headers: headers,
            data: qs.stringify(data),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.setState("info.connection", false, true);
                this.log.error(error);

                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
    }
    async getDeviceList() {
        const headers = {
            "Content-Type": "application/json",
            Accept: "*/*",
            "User-Agent": "ioBroker 1.0.0",
            Authorization: "Bearer " + this.session.id_token,
            "x-api-key": this.config.subKey,
        };
        await this.requestClient({
            method: "get",
            url: "https://zehnder-prod-we-apim.azure-api.net/cloud/api/v2.1/devices/ids",
            headers: headers,
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                for (const device of res.data.data) {
                    this.idArray.push(device.id);
                    await this.setObjectNotExistsAsync(device.id, {
                        type: "device",
                        common: {
                            name: device.modelId,
                        },
                        native: {},
                    });

                    await this.setObjectNotExistsAsync(device.id + ".general", {
                        type: "channel",
                        common: {
                            name: "General Device Information",
                        },
                        native: {},
                    });

                    this.json2iob.parse(device.id + ".general", device);
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }
    async updateDevices() {}
    async refreshToken() {
        await this.requestClient({
            method: "post",
            url: "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/B2C_1_signin_signup_enduser/oauth2/v2.0/token",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "ioBroker 1.0",
            },
            data: "grant_type=refresh_token&client_id=df77b1ce-c368-4f7f-b0e6-c1406ac6bac9&refresh_token=" + this.session.refresh_token,
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
                return res.data;
            })
            .catch((error) => {
                this.setState("info.connection", false, true);
                this.log.error("refresh token failed");
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error("Start relogin in 1min");
                this.reLoginTimeout = setTimeout(() => {
                    this.login();
                }, 1000 * 60 * 1);
            });
    }

    getCodeChallenge() {
        let hash = "";
        let result = "";
        const chars = "0123456789abcdef";
        result = "";
        for (let i = 64; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
        hash = crypto.createHash("sha256").update(result).digest("base64");
        hash = hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

        return [result, hash];
    }
    randomString(length) {
        let result = "";
        const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearInterval(this.updateInterval);
            clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new ZehnderCloud(options);
} else {
    // otherwise start the instance directly
    new ZehnderCloud();
}
