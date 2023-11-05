'use strict';

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;

const Json2iob = require('json2iob');
class ZehnderCloud extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'zehnder-cloud',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.idArray = [];

    this.session = {};
    this.json2iob = new Json2iob(this);

    // this.cookieJar = new tough.CookieJar();
    this.requestClient = axios.create();
    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Initialize your adapter here

    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }

    this.subscribeStates('*.remote.*');
    if (!this.config.apikey || !this.config.apiname) {
      this.log.error('Please set apikey and name in the adapter settings!');
      return;
    }

    await this.getDeviceList();
    this.updateDevices();
    this.updateInterval = setInterval(async () => {
      await this.updateDevices();
    }, this.config.interval * 60 * 1000);
  }

  async getDeviceList() {
    this.log.info('Getting device list...');
    const headers = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': 'ioBroker 2.0.0',
      'Zehnder-ApiName': this.config.apiname,
      'Zehnder-ApiKey': this.config.apikey,
      'x-api-key': this.config.subKeyNew,
    };
    await this.requestClient({
      method: 'get',
      url: 'https://zehnder-test-we-apim.azure-api.net/cloud/api/v2.1/devices/ids',
      headers: headers,
    })
      .then(async (res) => {
        this.setState('info.connection', true, true);
        this.log.debug(JSON.stringify(res.data));
        this.idArray = res.data;
        this.log.info('Found ' + this.idArray.length + ' devices.');
        await this.getDeviceDetails();
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async getDeviceDetails() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': 'ioBroker 2.0.0',
      'Zehnder-ApiName': this.config.apiname,
      'Zehnder-ApiKey': this.config.apikey,
      'x-api-key': this.config.subKeyNew,
    };
    for (let id of this.idArray) {
      id = id.toString();
      await this.requestClient({
        method: 'get',
        url: 'https://zehnder-test-we-apim.azure-api.net/cloud/api/v2.1/devices/byid/' + id + '/details',
        headers: headers,
      })
        .then(async (res) => {
          this.log.debug('Details:');
          this.log.debug(JSON.stringify(res.data));
          const device = res.data;
          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: device.assistantName || device.description,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'setVentilationPreset-value', name: 'Example: Away', type: 'string', role: 'text' },
            { command: 'setManualMode-enabled', name: 'True = Start, False = Stop' },
            { command: 'setAway-enabled', name: 'True = Start, False = Stop' },
            { command: 'setBoostTimer-seconds', name: 'Booster Timer in seconds', type: 'number', role: 'value' },
            { command: 'setExhaustFanOff-seconds', name: 'Exhaust Fan Off in seconds', type: 'number', role: 'value' },
            { command: 'setSupplyFanOff-seconds', name: 'Supply Fan Off in seconds', type: 'number', role: 'value' },
            { command: 'forceBypass-seconds', name: 'Force Bypass in seconds', type: 'number', role: 'value' },
            { command: 'setRMOTCool-temperature', name: 'Temperature', type: 'number', role: 'value' },
            { command: 'setRMOTHeat-temperature', name: 'Temperature', type: 'number', role: 'value' },
            { command: 'setTemperatureProfile-mode', name: 'Example: Cool, Heat', type: 'string', role: 'text' },
            { command: 'setComfortMode-mode', name: 'Example: Adaptive', type: 'string', role: 'text' },
            { command: 'setPassiveTemperatureMode-mode', name: 'Off, On', type: 'string', role: 'text' },
            { command: 'setHumidityComfortMode-mode', name: 'Off, On', type: 'string', role: 'text' },
            { command: 'setHumidityProtectionMode-mode', name: 'Off, On', type: 'string', role: 'text' },
            { command: 'forceRefresh', name: 'True = Refresh' },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
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
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': 'ioBroker 2.0.0',
      'Zehnder-ApiName': this.config.apiname,
      'Zehnder-ApiKey': this.config.apikey,
      'x-api-key': this.config.subKeyNew,
    };
    const statusArray = [
      {
        path: 'state',
        url: 'https://zehnder-test-we-apim.azure-api.net/cloud/api/v2.1/devices/{deviceId}/state',
        desc: 'Current status of the device',
      },
      {
        path: 'weather',
        url: 'https://zehnder-test-we-apim.azure-api.net/cloud/api/v2.1/devices/{deviceId}/weather',
        desc: 'Current weather of the device',
      },
    ];
    for (let id of this.idArray) {
      id = id.toString();
      for (const element of statusArray) {
        const url = element.url.replace('{deviceId}', id);
        await this.requestClient({
          method: 'get',
          url: url,
          headers: headers,
        })
          .then(async (res) => {
            this.log.debug(element.path);
            this.log.debug(JSON.stringify(res.data));
            const state = res.data.values;
            await this.setObjectNotExistsAsync(id + '.' + element.path, {
              type: 'channel',
              common: {
                name: element.desc,
              },
              native: {},
            });

            this.json2iob.parse(id + '.' + element.path, state, { autoCast: true });
          })
          .catch((error) => {
            this.log.error('Failed: ' + element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.updateInterval && clearInterval(this.updateInterval);
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
        if (id.indexOf('.remote.') === -1) {
          this.log.info('Please use remote to control device ');
          return;
        }

        const deviceId = id.split('.')[2];

        let command = id.split('.')[4];
        if (command === 'forceRefresh') {
          this.updateDevices();
          return;
        }
        const action = command.split('-')[1];
        command = command.split('-')[0];

        const data = {};
        data[command] = {};
        data[command][action] = state.val;
        this.log.debug(JSON.stringify(data));

        const headers = {
          'Content-Type': 'application/json',
          Accept: '*/*',
          'User-Agent': 'ioBroker 2.0.0',
          'Zehnder-ApiName': this.config.apiname,
          'Zehnder-ApiKey': this.config.apikey,
          'x-api-key': this.config.subKeyNew,
        };
        await this.requestClient({
          method: 'put',
          url: 'https://zehnder-test-we-apim.azure-api.net/cloud/api/v2.1/devices/' + deviceId + '/comfosys/settings',
          headers: headers,
          data: data,
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            res.status && this.log.debug(res.status.toString());
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
        // const vin = id.split('.')[2];
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
