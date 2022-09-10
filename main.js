"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const qs = require("qs");

const crypto = require("crypto");
const Json2iob = require("./lib/json2iob");
const { wrapper } = require("axios-cookiejar-support");
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
    this.idArray = [];

    this.session = {};
    this.json2iob = new Json2iob(this);
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
    this.cookieJar = new tough.CookieJar();
    this.requestClient = wrapper(axios.create({ jar: this.cookieJar }));
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;

    this.subscribeStates("*.remote.*");
    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the adapter settings!");
      return;
    }
    await this.login();

    if (this.session.id_token) {
      await this.getDeviceList();
      this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, (this.session.id_token_expires_in - 100) * 1000);
    }
  }
  async login() {
    const [code_verifier, codeChallenge] = this.getCodeChallenge();
    const headers = {
      "User-Agent": "ioBroker 1.0",
    };
    const url =
      "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/oauth2/v2.0/authorize?p=B2C_1_signin_signup_enduser&client_id=df77b1ce-c368-4f7f-b0e6-c1406ac6bac9&nonce=" +
      this.randomString(16) +
      "&redirect_uri=https%3A%2F%2Flocalhost%2Fmyweb&scope=openid%20offline_access&response_type=code&prompt=login&code_challenge=" +
      codeChallenge +
      "&code_challenge_method=S256";
    this.log.debug(url);
    const htmlLoginForm = await this.requestClient({
      method: "get",
      url: url,
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
      url:
        "https://zehndergroupauth.b2clogin.com/zehndergroupauth.onmicrosoft.com/B2C_1_signin_signup_enduser/SelfAsserted?tx=StateProperties=" +
        state +
        "&p=B2C_1_signin_signup_enduser",
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
          const pathUrl = error.request.path ? error.request.path : error.request._currentUrl;
          this.log.debug(pathUrl);
          code = qs.parse(pathUrl.split("?")[1]).code;
          this.log.debug(code);
          return code;
        }
      });
    data = {
      grant_type: "authorization_code",
      code: code,
      redirect_uri: "https://localhost/myweb",
      scope: "openid offline_access",
      code_verifier: code_verifier,
    };
    this.log.debug(JSON.stringify(data));
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
    this.log.info("Getting device list...");
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
        this.idArray = res.data;
        this.log.info("Found " + this.idArray.length + " devices.");
        await this.getDeviceDetails();
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async getDeviceDetails() {
    const headers = {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "ioBroker 1.0.0",
      Authorization: "Bearer " + this.session.id_token,
      "x-api-key": this.config.subKey,
    };
    for (let id of this.idArray) {
      id = id.toString();
      await this.requestClient({
        method: "get",
        url: "https://zehnder-prod-we-apim.azure-api.net/cloud/api/v2.1/devices/byid/" + id + "/details",
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug("Details:");
          this.log.debug(JSON.stringify(res.data));
          const device = res.data;
          await this.setObjectNotExistsAsync(id, {
            type: "device",
            common: {
              name: device.assistantName || device.description,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + ".remote", {
            type: "channel",
            common: {
              name: "Remote Controls",
            },
            native: {},
          });

          const remoteArray = [
            { command: "setVentilationPreset-value", name: "Example: Away", type: "string" },
            { command: "setManualMode-enabled", name: "True = Start, False = Stop" },
            { command: "setAway-enabled", name: "True = Start, False = Stop" },
            { command: "setBoostTimer-seconds", name: "Booster Timer in seconds", type: "number", role: "value" },
            { command: "setExhaustFanOff-seconds", name: "Exhaust Fan Off in seconds", type: "number", role: "value" },
            { command: "setSupplyFanOff-seconds", name: "Supply Fan Off in seconds", type: "number", role: "value" },
            { command: "forceBypass-seconds", name: "Force Bypass in seconds", type: "number", role: "value" },
            { command: "setRMOTCool-temperature", name: "Temperature", type: "number", role: "value" },
            { command: "setRMOTHeat-temperature", name: "Temperature", type: "number", role: "value" },
            { command: "setTemperatureProfile-mode", name: "Example: Cool, Heat", type: "string" },
            { command: "setComfortMode-mode", name: "Example: Adaptive", type: "string" },
            { command: "setPassiveTemperatureMode-mode", name: "Off, On", type: "string" },
            { command: "setHumidityComfortMode-mode", name: "Off, On", type: "string" },
            { command: "setHumidityProtectionMode-mode", name: "Off, On", type: "string" },
            { command: "forceRefresh", name: "True = Refresh" },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(id + ".remote." + remote.command, {
              type: "state",
              common: {
                name: remote.name || "",
                type: remote.type || "boolean",
                role: remote.role || "boolean",
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(id, device, { autoCast: true, forceIndex: true });
        })
        .catch((error) => {
          this.log.error(error);
          error.response && this.log.error(JSON.stringify(error.response.data));
        });
    }
  }
  async updateDevices() {
    const headers = {
      "Content-Type": "application/json",
      Accept: "*/*",
      "User-Agent": "ioBroker 1.0.0",
      Authorization: "Bearer " + this.session.id_token,
      "x-api-key": this.config.subKey,
    };
    const statusArray = [
      {
        path: "state",
        url: "https://zehnder-prod-we-apim.azure-api.net/cloud/api/v2.1/devices/{deviceId}/state",
        desc: "Current status of the device",
      },
      {
        path: "weather",
        url: "https://zehnder-prod-we-apim.azure-api.net/cloud/api/v2.1/devices/{deviceId}/weather",
        desc: "Current weather of the device",
      },
    ];
    for (let id of this.idArray) {
      id = id.toString();
      for (const element of statusArray) {
        const url = element.url.replace("{deviceId}", id);
        await this.requestClient({
          method: "get",
          url: url,
          headers: headers,
        })
          .then(async (res) => {
            this.log.debug(element.path);
            this.log.debug(JSON.stringify(res.data));
            const state = res.data.values;
            await this.setObjectNotExistsAsync(id + "." + element.path, {
              type: "channel",
              common: {
                name: element.desc,
              },
              native: {},
            });

            this.json2iob.parse(id + "." + element.path, state, { autoCast: true });
          })
          .catch((error) => {
            this.log.error("Failed: " + element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }
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
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
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
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        if (id.indexOf(".remote.") === -1) {
          this.log.info("Please use remote to control device ");
          return;
        }

        const deviceId = id.split(".")[2];

        let command = id.split(".")[4];
        if (command === "forceRefresh") {
          this.updateDevices();
          return;
        }
        const action = command.split("-")[1];
        command = command.split("-")[0];

        const data = {};
        data[command] = {};
        data[command][action] = state.val;
        this.log.debug(JSON.stringify(data));

        const headers = {
          "Content-Type": "application/json",
          Accept: "*/*",
          "User-Agent": "ioBroker 1.0.0",
          Authorization: "Bearer " + this.session.id_token,
          "x-api-key": this.config.subKey,
        };
        await this.requestClient({
          method: "put",
          url: "https://zehnder-prod-we-apim.azure-api.net/cloud/api/v2.1/devices/" + deviceId + "/comfosys/settings",
          headers: headers,
          data: data,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            this.log.debug(res.status);
            return res.data;
          })
          .catch((error) => {
            this.log.error(error);
            if (error.response) {
              this.log.error(JSON.stringify(error.response.data));
            }
          });
        this.refreshTimeout && clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          await this.updateDevices();
        }, 10 * 1000);
      } else {
        // const resultDict = { chargingStatus: "CHARGE_NOW", doorLockState: "DOOR_LOCK" };
        // const idArray = id.split(".");
        // const stateName = idArray[idArray.length - 1];
        const vin = id.split(".")[2];
        // if (resultDict[stateName]) {
        //     let value = true;
        //     if (!state.val || state.val === "INVALID" || state.val === "NOT_CHARGING" || state.val === "ERROR" || state.val === "UNLOCKED") {
        //         value = false;
        //     }
        //     await this.setStateAsync(vin + ".remote." + resultDict[stateName], value, true);
        // }
      }
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
