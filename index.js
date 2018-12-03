#!/usr/bin/env node

const sp = require('serialport');
const comms = require('ncd-red-comm');
const inquirer = require('inquirer');

process.on('unhandledRejection', (r) => {
  console.error('Error thrown: ');
  console.error(r);
  process.kill(1);
});


var prompt = inquirer.createPromptModule();

var modem;

function selectPort(){
	return new Promise((f, r) => {
		sp.list().then((ports) => {
			var names = ports.map(o => o.comName);
			prompt({
				name: 'port_selected',
				type: 'list',
				message: `Please select an option below, or type a number 1-${names.length}, then hit enter:`,
				choices: names
			}).then((r) => {
				for(var i in ports){
					if(ports[i].comName == r.port_selected){
						f(getModem(ports[i].comName));
						return;
					}
				}
				r('failed to find to modem!!!');
			});
		}).catch(console.log);
	});
}

function countdown(message, ms){
	var stop = Date.now() + ms;
	return new Promise((f) => {
		function _countdown(first){
			if(!first){
				process.stdout.clearLine();
				process.stdout.cursorTo(0);
			}
			var now = Date.now();
			if(stop > now){
				var remaining = Math.ceil((stop - now) / 1000);
				process.stdout.write(`${message}: ${remaining} seconds left`);
				setTimeout(_countdown, 500);
			}else{
				f();
			}
		}
		_countdown(true);
	});
}

function getModem(port){
	var serial = new comms.NcdSerial(port, 115200);
	return new comms.NcdDigiParser(serial);
}

selectPort().then((modem) => {
	find_nodes(modem).then((response) => {
		var [nodes, power] = response;
		var promises = [];
		var macs = Object.values(nodes);
		modem._timoutLimit = 5000;
		console.log(`Attempting to update ${macs.length} modules...`);
		var success = 0;
		var fail = [];
		macs.forEach((mac) => {
			promises.push(modem.send.remote_at_command(mac, 'PL', [parseInt(power)]));
		});
		Promise.all(promises).then((responses) => {
			var total = macs.length;
			var failed = responses.filter((resp) => {
				return resp.status != 'OK';
			});
			console.log(`Successfully updated ${total - failed.length} module(s)!`);
			if(failed.length){
				console.log(`Failed to update ${failed.length} module(s):`);
				var fmacs = failed.map((d) => d.remote_mac);
				console.log(fmacs.join("\n"));
			}
			process.exit();
		});
		//process changes
	});
}).catch(console.log);

function setNT(modem){
	return new Promise((fulfill, reject) => {
		modem.send.at_command('NT').then((r) => {
			var nt = Buffer.from(r.data).readInt16BE(0);
			prompt({
				name: 'to',
				message: `How many seconds should we look for devices? [4-1200]`,
				type: 'input',
				default: nt/10,
				validate: function(input){
					return new Promise((f, r) => {
						var n = parseInt(input);
						if(n < 4 || n > 1200){
							r('Value must be between 4 and 1200');
						}else{
							f(true);
						}
					});

				}
			}).then((answers) => {
				if(parseInt(answers.to) != nt){
					nt = answers.to * 10;
					modem.send.at_command('NT', [nt >> 8, nt & 255]).then((response) => {
						if(response.status == 'OK'){
							fulfill(answers.to * 1000);
						}else{
							console.log(response);
							console.log(Buffer.from([answers.to >> 8, answers.to & 255]));
							reject('Could not set discovery timeout value');
						}
					}).catch(reject);
				}else{
					fulfill(nt * 100);
				}
			}).catch(reject);
		});
	});
}

function find_nodes(modem){
	return new Promise((fulfill, reject) => {
		var addrs = {};
		setNT(modem).then((_timeoutLimit) => {
			modem._timoutLimit = _timeoutLimit;
			prompt({
				type: 'list',
				name: 'power',
				message: 'Select Power Level',
				default: 0,
				choices: [
					{name: '+7 dBm (5 mW)', value: 0},
					{name: '+15 dBm (32 mW)', value: 1},
					{name: '+18 dBm (63 mW)', value: 2},
					{name: '+21 dBm (125 mW)', value: 3},
					{name: '+24 dBm (150 mW)', value: 4}
				],
			}).then((answers) => {
				var PL = answers.power;
				function ND_response(frame){
					if(frame.type == 'at_command_response' && frame.command == 'ND' && frame.status == 'OK'){
						var mac = frame.data.slice(2,10);
						addrs[Buffer.from(mac).toString('hex')] = mac;
					}
				}
				modem._emitter.on('digi_frame', ND_response);
				modem.send.at_command("ND").then().catch(console.log);
				countdown("Searching for devices", _timeoutLimit).then(() => {
					modem._emitter.removeListener('digi_frame', ND_response);
					fulfill([addrs, PL]);
				}).catch(console.log);
			}).catch(reject);
		}).catch(reject);
	});
}
