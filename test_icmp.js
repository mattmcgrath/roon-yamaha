const icmp = require('icmp');

icmp.send('192.168.0.106', "Hey, I'm sending a message!")
    .then(obj => {
        console.log(obj.open ? 'Done' : 'Failed')
    })
    .catch(err => console.log(err));