var dns = require('dns');

var _ = require('underscore');
var async = require('async');
var request = require('request');
var mongo = require('mongojs');
var ping = require('tcp-ping');

var logger = require('./utils/logger');
var transport = require('./transport');
var db = require('./db');

var beats = {
	// pings URL and measure the response time
	http: function (options, callback) {
		var url = options.url, started = new Date();

		logger.info('http: ' + url);

		request({url: url}, function (err, resp, body) {
			var time = new Date() - started;

			var report = (err || resp.statusCode !== 200) ?
				{success: false, url: url, responseTime: time, at: new Date(), statusCode: resp && resp.statusCode, message: 'ping failed', err: err} :
				{success: true, url: url, responseTime: time, at: new Date(), statusCode: resp.statusCode};

			report.success ? logger.success(report) : logger.error(report);

			callback(null, report);
		});
	},

	// requests URL and compare jsons
	json: function (options, callback) {
		var url = options.url, started = new Date(), expected = options.response;

		logger.info('json:' + url);

		request({url: options.url, json: true}, function (err, resp, body) {
			var time = new Date() - started;

			var report = (err || resp.statusCode !== 200) ?
				{success: false, url: url, responseTime: time, at: new Date(), statusCode: resp && resp.statusCode, message: 'json failed', err: err} :
				{success: true, url: url, responseTime: time, at: new Date(), statusCode: resp.statusCode};

			if (!_.isEqual(body, expected)) {
				report = {success: false, url: url, expected: expected, actual: body};
			}

			report.success ? logger.success(report) : logger.error(report);

			callback(null, report);
		});
	},

	// execute query and measure reponse time
	mongo: function (options, callback) {
		var connection = options.connection, started = new Date();
		var db = mongo.connect(connection, options.collections);
		if (!db) {
			return callback(null, {success: false, url: connection, message: 'failed to connect database'});
		}

		logger.info('mongo query:' + connection);

		options.query(db, function (err) {
			var time = new Date() - started;

			db.close();

			var report = err ?
				{success: false, url: connection, at: new Date(), responseTime: time, message: 'mongo failed', err: err} :
				{success: true, url: connection, at: new Date(), responseTime: time};

			report.success ? logger.success(report) : logger.error(report);

			callback(null, report);
		});
	},

	// resolves all ip's by given DNS and pings each
	resolve: function (options, callback) {
		var name = options.name;

		logger.info('resolve: ' + name);

		dns.resolve4(name, function (err, addresses) {
			if (err) {
				return callback(null, {success: false, url: name, message: 'failed resolved ip by name'});
			}

			async.map(addresses, function (address, callback) {
				var started = new Date();

				ping.probe(address, 80, function (err, resolved) {
					var time = new Date() - started;

					var report = (err || !resolved) ?
						{success: false, url: address, responseTime: time, at: new Date(), message: 'ping failed', err: err} :
						{success: true, url: address, responseTime: time, at: new Date()};

					report.success ? logger.success(report) : logger.error(report);

					callback(null, report);
				});
			}, callback);
		});
	},

	// pings the ip address
	ping: function (options, callback) {
		var ip = options.ip;

		logger.info('ping: ' + ip);

		var started = new Date();

		ping.probe(ip, 80, function (err, resolved) {
			var time = new Date() - started;

			var report = (err || !resolved) ?
				{success: false, url: ip, responseTime: time, at: new Date(), message: 'ping failed', err: err} :
				{success: true, url: ip, responseTime: time, at: new Date()};

			report.success ? logger.success(report) : logger.error(report);

			callback(null, report);
		});
	}
};

var notifiers = {
	email: function (options, failure, callback) {
		var text = JSON.stringify(failure);
		var subject = '[Heartbeat] Service ' + failure.url + ' failed.';
		var from = options.from;
		var to = options.to.map(function (t) {
			return {email: t};
		});

		var message = {
			text: text,
			subject: subject,
			from_email: from,
			to: to
		};

		logger.info('sending mandrill notification');

		transport.mandrill('/messages/send', {
			message: message
		}, callback);
	},

	sms: function (options, failure, callback) {
		var text = JSON.stringify(failure);
		var from = options.from;
		var to = options.to;

		var message = {
			body: text,
			from: from,
			to: to
		};

		transport.twilio.sendMessage(message, callback);
	}
};

function heart(type, options) {
	var beat = beats[type];

	if (!beat) {
		throw new Error('missing beat type for: ' + type);
	}

	return function (callback) {
		//beat(options, callback);
		beat.call(beats, options, callback);
	};
}

function notify(type, options) {
	var notif = notifiers[type];

	if (!type) {
		throw new Error('missing notifier type for: ' + type);
	}

	return function (failures, callback) {
		async.each(failures, function (failure, callback) {
			notif(options, failure, callback);
		}, callback);
	};
}

function notification(options) {
	var notifications = Object.keys(options).map(function (k) {
		return notify(k, options[k]);
	});

	return function (failures, callback) {
		async.each(notifications, function (notification, callback) {
			notification(failures, callback);
		}, callback);
	};
}

function job(type, array, notify, db) {
	var hearts = array.map(function (e) {
		return heart(type, e);
	});

	return function (callback) {
		async.parallel(hearts, function (err, results) {
			if (err) {
				return callback(err);
			}

			// save job results and notify failures..
			db.heartbeats.insert(results, function (err) {
				if (err) {
					return callback(err);
				}

				var failures = results.filter(function (r) {
					return !r.success;
				});

				notify(failures, callback);
			});

		});
	};
}

function heartbeat(config) {
	if (!config) {
		throw new Error('config is missing');
	}

	if (!config.monitor) {
		throw new Error('config.monitor section is missing');
	}

	if (!config.notify) {
		throw new Error('config.notify section is missing');
	}

	var local = db(config);
	var notify = notification(config.notify);
	var jobs = Object.keys(config.monitor).map(function (k) {
		return job(k, config.monitor[k], notify, local);
	});

	return {
		start: function () {
			// heartbeating cycle..
			(function cycle() {
				async.series(jobs, function (err) {
					if (err) {
						logger.error(err);
					}

					var interval = config.interval || 10000;
					logger.info('heartbeat interval over, restarting after ' + interval + ' msec.');

					setTimeout(cycle, interval);
				});
			})();
		}
	};
}

module.exports = heartbeat;