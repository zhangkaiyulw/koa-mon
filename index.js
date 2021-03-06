const mongoose = require('mongoose');
const glob = require('glob');
const chalk = require('chalk');
const path = require('path');

const isCapitalized = function(s) {
  const charCode = s.substr(0, 1).charCodeAt(0);
  return charCode >= 65 && charCode <= 90;
};

const timestamp = function() {
  const time = new Date();
  const dateStr = time.toLocaleDateString('en', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const timeStr = time.toLocaleTimeString('en', {
    hour12: false,
    timeZoneName: 'short'
  });
  return `[${dateStr} ${timeStr}]`;
};

const log = function(s, connectionName) {
  console.log(`${chalk.blue(timestamp())}\
${chalk.magenta.bold(connectionName ? `[${connectionName}]` : '[DB]')} ${s}`);
};

module.exports = function({
  url, options, modelDir, debug, lazyConnect, connectionName, plugins, types
}) {

  // configure mongoose
  mongoose.set('debug', mongoose.get('debug') || debug);

  // Connection Handlers
  const defaultOptions = {
    autoReconnect: true,
    reconnectTries: Number.MAX_VALUE,
    reconnectInterval: 2000
  };

  options = Object.assign({}, defaultOptions, options);

  let connection = undefined,
    connected = false,
    reconnectTries = 0,
    eventsAttached = false;
  const models = {};

  const connect = function(url, options) {
    options.useNewUrlParser = true; // fix warning
    log(`Using ${url}.`, connectionName);
    log(`Connecting...`, connectionName);
    if (connectionName) {
      connection = mongoose.createConnection(url, options);
    } else {
      mongoose.connect(url, options).catch(() => {});
      connection = mongoose.connection;
    }
    if (!eventsAttached) {
      connection.on('error', () => {
        connected = false;
        log(`Error Occurred.`, connectionName);
        if (options.autoReconnect !== false) {
          if (reconnectTries <
            (options.reconnectTries || defaultOptions.reconnectTries)) {
            setTimeout(() => {
              connect(url, options);
              reconnectTries += 1;
            }, options.reconnectInterval || defaultOptions.reconnectInterval);
          }
        }
      });

      connection.on('disconnected', function () {
        connected = false;
        log(`Disconnected.`, connectionName);
      });

      connection.on('connected', function () {
        connected = true;
        reconnectTries = 0;
        log(`Connected.`, connectionName);
        unlock();
      });

      // Load plugins
      if (plugins && Array.isArray(plugins)) {
        plugins.forEach((plugin) => {
          mongoose.plugin(plugin);
        });
      }

      // Load types
      if (types && Array.isArray(types)) {
        types.forEach((type) => {
          type(mongoose);
        });
      }

      // Load models
      const modelPaths = glob.sync(modelDir + '/**/*.js');
      const modelObjects = modelPaths.map(require);
      modelObjects.forEach((o, i) => {
        const name = path.parse(modelPaths[i]).name;
        if ((o.constructor === mongoose.Schema) && isCapitalized(name)) {
          models[name] = connection.model(name, o);
        }
      });
      eventsAttached = true;
    }
  };

  const locks = [];

  const lock = () =>
    new Promise(function(res, _rej) {
      locks.push(res);
    });

  const unlock = () => {
    while (locks.length) {
      const res = locks.pop();
      res();
    }
  };

  if (!lazyConnect) {
    connect(url, options);
  }

  // Middleware setup
  return async function(ctx, next) {
    ctx.mongoose = mongoose;
    if (connectionName) {
      ctx.connections = Object.assign(
        {},
        ctx.connections,
        { [connectionName]: connection }
      );
      !ctx[connectionName] && (ctx[connectionName] = models);
    }
    ctx.models = Object.assign({}, mongoose.models, ctx.models, models);
    if (!connected) {
      if (lazyConnect) {
        connect(url, options);
        lazyConnect = false;
      }
      await lock();
    }
    await next();
  };
};
