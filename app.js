var RoonApi = require("node-roon-api"),
    RoonApiStatus = require("node-roon-api-status");
    RoonApiSettings  = require("node-roon-api-settings"),
    RoonApiSourceControl = require("node-roon-api-source-control"),
    RoonApiVolumeControl = require("node-roon-api-volume-control"),
    YamahaYXC = require("yamaha-yxc-nodejs");

var roon = new RoonApi({
    extension_id:        'com.mattmcgrath.roonyamahacontrolyxc',
    display_name:        "Roon Yamaha Control YXC",
    display_version:     "0.0.1",
    publisher:           'Matthew R. McGrath',
    email:               'matthew (no space) mcg (at) (hotmail)',
    website:             'https://github.com/mattmcgrath/roon-yamaha-control-yxc'
});

var svc_status = new RoonApiStatus(roon);
var svc_volume = new RoonApiVolumeControl(roon);
var svc_source = new RoonApiSourceControl(roon);
var svc_settings = new RoonApiSettings(roon);

var yamaha = {
    "default_device_name": "Yamaha",
    "default_input": "coaxial",
    "volume": -70
};

var volTimeout = null;

var mysettings = roon.load_config("settings") || {
    receiver_url: "",
    input: yamaha.default_input,
    device_name: yamaha.default_device_name,
    input_list: ["coaxial"]
}

function makelayout(settings) {
    var l = {
        values:    settings,
        layout:    [],
        has_error: false
    };

    l.layout.push({
        type:    "string",
        title:   "Device name",
        subtitle: "Changing this might take some time to take effect.",
        setting: "device_name"
    });

    l.layout.push({
        type:    "dropdown",
        title:   "Input",
        values:   mysettings.input_list,
        setting: "input"
    });

    let v = {
        type:    "string",
        title:   "Receiver IP",
        subtitle: "Your device should be recognized automatically. If not, please configure your receiver to use a fixed IP-address.",
        setting: "receiver_url"
    };

    if (settings.receiver_url != "" && settings.receiver_url.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/) === null) {
        v.error = "Please enter a valid IP-address";
        l.has_error = true; 
    }
    l.layout.push(v);

    return l;
}

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            mysettings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", mysettings);
        }
    }
});

svc_status.set_status("Initializing.", false)

function update_status() {
    if (yamaha.hid && yamaha.device_name) {
        svc_status.set_status("Found Yamaha " + yamaha.device_name + " at " + yamaha.ip, false);    
    } else if (yamaha.hid && yamaha.ip) {
        svc_status.set_status("Found Yamaha device at " + yamaha.ip, false);    
    } else if (yamaha.hid) {
        svc_status.set_status("Found Yamaha device. Discovering…", false);    
    } else {
        svc_status.set_status("Could not find Yamaha device while updating status.", true)
    }
}

function check_status() {
    if (yamaha.hid) {
        yamaha.hid.getStatus()
        .then( (json_result) => {
            // exit if a change through roon is in progress
            if (volTimeout) return;
            // this seems to only get called on success
            // should get current state first, to see if update is necessary
            
            result = JSON.parse(json_result);
            yamaha.svc_volume.update_state({
                volume_value: result.volume - 80,
                is_muted: result.mute
            });
            yamaha.source_control.update_state({
                status: (result.power == "on")? "selected": "standby"
            });
            update_status()
        })
        .catch( (error) => {
            // this seems not to get called when device is offline
            yamaha.hid == "";
            svc_status.set_status("Could not find Yamaha device while checking status.", true);
        });
    }
}

function setup_yamaha() {
    if (yamaha.hid) {
        yamaha.hid = undefined;
    }
    if (yamaha.source_control) {
        yamaha.source_control.destroy();
        delete(yamaha.source_control);
    }
    if (yamaha.svc_volume) {
        yamaha.svc_volume.destroy();
        delete(yamaha.svc_volume);
    }

    yamaha.hid = new YamahaYXC(mysettings.receiver_url);
    // should check whether the device is behind the given url
    // only then start to discover.
    yamaha.hid.discover()
    .then( (ip) => {
        yamaha.ip = ip;
        update_status();
    })
    .catch( (error) => {
        yamaha.hid = undefined;
        svc_status.set_status("Could not find Yamaha device for setup.", true)
    });
    
    try {
        yamaha.hid.getDeviceInfo().then(function(config) {
            if (mysettings.device_name == yamaha.default_device_name) {
                mysettings.device_name = "Yamaha " + config["model_name"];
            }
            update_status();
        })
        yamaha.hid.getFeatures().then(function(result) {
            let inputs = JSON.parse(result).system.input_list;
            mysettings.input_list = [];
            for (let key in inputs) {
                mysettings.input_list.push({
                    "title": inputs[key].id,
                    "value": inputs[key].id
                })
            }
            update_status();
        })
    } catch(e) {
        // getting the device name is not critical, so let's continue
    }

    yamaha.svc_volume = svc_volume.new_device({
        state: {
            display_name: mysettings.device_name,
            volume_type:  "db",
            volume_min:   -80,
            volume_max:   0,
            volume_value: -80,
            volume_step:  1,
            is_muted:     0
        },
        set_volume: function (req, mode, value) {
            let newvol = mode == "absolute" ? value : (yamaha.volume + value);
            if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
            else if (newvol > this.state.volume_max) newvol = this.state.volume_max;
            yamaha.svc_volume.update_state({ volume_value: newvol });
            
            clearTimeout(volTimeout);
            volTimeout = setTimeout(() => {
                // node-yamaha-avr sends full ints
                yamaha.hid.setVolumeTo(value + 80);
                clearTimeout(volTimeout);
                volTimeout = null;
            }, 500)
            req.send_complete("Success");
        },
        set_mute: function (req, action) {
            let is_muted = !this.state.is_muted;
            yamaha.hid.mute(is_muted)
            yamaha.svc_volume.update_state({ is_muted: is_muted });
            req.send_complete("Success");
        }

    });

    yamaha.source_control = svc_source.new_device({
        state: {
            display_name: mysettings.device_name,
            supports_standby: true,
            status: "selected",
        },
        convenience_switch: function (req) {
            yamaha.hid.power("on");
            yamaha.hid.setInput(mysettings.input);
            req.send_complete("Success");
        },
        standby: function (req) {
            let state = this.state.status;
            this.state.status = (state == "selected")? "standby" : "selected";
            yamaha.hid.power((state == "selected")? "standby": "on");
            req.send_complete("Success");
        }
    });
}

roon.init_services({
    provided_services: [ svc_status, svc_settings, svc_volume, svc_source ]
});

setInterval(() => { if (!yamaha.hid) setup_yamaha(); }, 1000);
setInterval(() => { if (yamaha.hid) check_status(); }, 5000);

roon.start_discovery();