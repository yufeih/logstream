'use strict'

require('babel-register');

global.navigator = { userAgent: 'all'};

var express = require('express');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var expressSession = require('express-session');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var db = require('./src/db').Database('redis');
var Connections = require('./src/connections').Connections;
var LogCounter = require('./src/utils').LogCounter;
/* react */
var swig = require('swig');
var React = require('react');
var ReactDOM = require('react-dom');
var ReactDOMServer = require('react-dom/server')
var Router = require('react-router');
var routes = require('./app/routes');
// AAD
var passport = require('passport');
var OIDCStrategy = require('passport-azure-ad').OIDCStrategy;
var config = require('./config');


// Passport session setup. 

//   To support persistent login sessions, Passport needs to be able to
//   serialize users into and deserialize users out of the session.  Typically,
//   this will be as simple as storing the user ID when serializing, and finding
//   the user by ID when deserializing.

// array to hold logged in users
var users = [];

var findByEmail = function (email, fn) {
    for (var i = 0; i < users.length; i++) {
        if (users[i].email === email) {
            return fn(null, users[i]);
        }
    }
    return fn(null, null);
};

passport.serializeUser(function (user, done) {
    done(null, user.email);
});

passport.deserializeUser(function (id, done) {
    findByEmail(id, done);
});

// Use the OIDCStrategy within Passport. (Section 2) 
// 
//   Strategies in passport require a `validate` function, which accept
//   credentials (in this case, an OpenID identifier), and invoke a callback
//   with a user object.
if (config.creds.clientID) {
    passport.use(new OIDCStrategy({
        callbackURL: config.creds.returnURL,
        realm: config.creds.realm,
        clientID: config.creds.clientID,
        clientSecret: config.creds.clientSecret,
        oidcIssuer: config.creds.issuer,
        identityMetadata: config.creds.identityMetadata,
        skipUserProfile: config.creds.skipUserProfile,
        responseType: config.creds.responseType,
        responseMode: config.creds.responseMode
        },
        function (iss, sub, profile, accessToken, refreshToken, done) {
            if (!profile.email) {
                return done(new Error("No email found"), null);
            }
            // asynchronous verification, for effect...
            process.nextTick(function () {
                findByEmail(profile.email, function (err, user) {
                    if (err) {
                        return done(err);
                    }
                    if (!user) {
                        // "Auto-registration"
                        users.push(profile);
                        return done(null, profile);
                    }
                    return done(null, user);
                });
            });
        }
    ));
}



/* Middleware */
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.text({ limit: '5mb' }));
app.use(cookieParser());
app.use(expressSession({ secret: 'keyboard cat', resave: true, saveUninitialized: false }));
app.use(bodyParser.urlencoded({ extended : true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));
app.use(function(req, res, next) {
    global.navigator = {
        userAgent: req.headers['user-agent']
    }
    next();
});



db.connect(
    process.env.REDIS_HOST,
    process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    process.env.REDIS_PASSWORD,
    process.env.REDIS_TLS ? JSON.parse(process.env.REDIS_TLS) : null
);


var connections = new Connections(http);
var logCounter = new LogCounter(500);

var LogStream = require('./drivers/nodejs/logstream').LogStream;
var logstream = new LogStream(
    process.env.LOGSTREAM_HOST || 'localhost', 
    process.env.LOGSTREAM_PORT ? Number(process.env.LOGSTREAM_PORT) : 3333, 
    'LogStream', 
    'Console'
);


/* RESTful API*/
function checkAPICall(req, res, next) {
    if (process.env.API_SECRET) {
        if (process.env.API_SECRET !== req.headers['api_secret']) {
            if (!connections.hasSession(req.query.sessionID)) {
                res.status(401).send();
                return;
            }
        }
    }
    return next();
}

function returnResult(res, successRet) {
    function ret(err, result) {
        res.setHeader('Content-Type', 'application/json');
        if (err) {
            res.status(400).send({error:err});
        }else {
            if (successRet) {
                res.status(200).send(typeof(successRet) === 'string' ? successRet : JSON.stringify(successRet));
            }else {
                res.status(200).send(JSON.stringify(result));
            }
        }
    }
    return ret;
}

// meta data
app.get('/api/projects', checkAPICall, function (req, res) {
    console.log('projects session', req.query.sessionID);

    console.log('[' + new Date().toLocaleString() + ']', 'get projects');
    logstream.log('GET projects');
        
    db.getProjects(returnResult(res));
});

// Logs
app.get('/api/*/*/logs', checkAPICall, function (req, res) {
    var project = req.params[0];
    var logname = req.params[1];
    var timestamp = req.query.timestamp;
    var count = req.query.count || 100000; // 100K logs, are you kidding me?

    if (isFinite(timestamp) && new Date(Number(timestamp)).getTime() > 0) { // check valid timestamp, (integer and convert to valid date)
        timestamp = Number(req.query.timestamp); // use user provided timestamp
    }else {
        timestamp = null; // give it null
    }

    console.log('[' + new Date().toLocaleString() + ']', 'get', project, logname, timestamp);
    logstream.log('get', project, logname, timestamp);

    db.getLogs(project, logname, timestamp, count, (err, result) => {
        if (timestamp === null) {
            connections.subscribe(req.query.sessionID, 'log', project, logname);
        }
        returnResult(res)(err, result);
    });
});

app.post('/api/*/*/logs', checkAPICall, function(req, res) {
    var project = req.params[0];
    var logname = req.params[1];
    var logtext = req.body.logtext;
    var timestamp = req.body.timestamp; 
    var level = req.body.level || 0; // support level for log
    if (isFinite(timestamp) && new Date(Number(timestamp)).getTime() > 0) { // check valid timestamp, (integer and convert to valid date)
        timestamp = Number(req.body.timestamp); // use user provided timestamp
    }else {
        timestamp = Date.now(); // use server timestamp if user not provide it
    }

    if (logtext) {        
        //console.log('[' + new Date().toLocaleString() + ']', 'POST', project + '/' + logname, '(' + logtext.length + 'bytes' + ')');
        //logstream.log('post', project, logname, logtext); DON'T DO IT!!!!!!!!!!!!!!!

        var logbranch = project + '/' + logname;
        logCounter.inc(logbranch);
        var count = logCounter.count(logbranch);
        var probality = 100.0 / count;
        var publish = Math.random() < probality;

        if (publish) {
            db.addLog(project, logname, logtext, timestamp, level, (err, result) => {
                var logs = [{timestamp: timestamp, logtext: logtext, level:level}];
                if (probality < 1.0) {
                    logs[0].logtext = '[probality: ' + Math.round(probality * 100.0) / 100.0 + '] ' + logs[0].logtext;
                }
                connections.publish('log', project, logname, logs);
                returnResult(res, req.body)(err, result);
            });
        }else {
            res.status(400).send({error:'too many logs!'});
        }
    }else {
        res.status(400).send({error:'invalid log'});
    }
});

app.post('/api/*/*/mlogs', checkAPICall, function(req, res) {
    var project = req.params[0];
    var logname = req.params[1];
    var logs = req.body;

    // default value
    var now = Date.now();
    for (var i=0; i<logs.length; i++) {
        logs[i].timestamp = logs[i].timestamp || now;
        logs[i].level = logs[i].level || 0; 
    }

    // check parameter 
    for (var i=0; i<logs.length; i++) {
        if (typeof(logs[i].timestamp) !== 'number' || 
            typeof(logs[i].level) !== 'number' ||
            !logs[i].logtext ||
            logs[i].logtext.length === 0) {

            res.status(400).send('invalid logs!');
            return;
        }
    }

    db.addLogs(project, logname, logs, (err, result) => {
        connections.publish('log', project, logname, logs);
        returnResult(res, logs.length)(err, result);
    });
});


// Commands
app.get('/api/*/*/commands', checkAPICall, function (req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'GET commands');
    logstream.log('GET commands');

    var project = req.params[0];
    var logname = req.params[1];
    db.getCommands(project, logname, returnResult(res));
});

app.get('/api/*/*/commands/*', checkAPICall, function (req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'GET commands/' + req.params[2]);
    logstream.log('GET commands/' + req.params[2]);
 
    var project = req.params[0];
    var logname = req.params[1];
    var command = req.params[2];
    // excute this command
    db.exeCommand(project, logname, command, returnResult(res));
});

app.post('/api/*/*/commands', checkAPICall, function (req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'POST commands');
    logstream.log('POST commands');

    var project = req.params[0];
    var logname = req.params[1];
    var commands = req.body;

    if (!commands || !Array.isArray(commands)) {
        res.status(400).send({error: 'command list is needed!'});
    }else {
        for (var i=0; i<commands.length; i++) {
            if (!commands[i].name || commands[i].name.length === 0) {
                res.status(400).send({error: 'command list is needed!'});
                return;
            }
            commands[i].url = commands[i].url || '#';
        }
        db.addCommands(project, logname, commands, returnResult(res, commands));    
    }
});

app.delete('/api/*/*/commands', checkAPICall, function (req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'DELETE commands');
    logstream.log('DELETE commands');

    var project = req.params[0];
    var logname = req.params[1];
    db.delCommands(project, logname, returnResult(res, ''));
});

// Charts
app.get('/api/*/*/charts', checkAPICall, function (req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'GET charts');
    logstream.log('GET charts', req.params[0], req.params[1]);

    var project = req.params[0];
    var logname = req.params[1];
    db.getCharts(project, logname, (err, result) => {
        connections.subscribe(req.query.sessionID, 'chart', project, logname);
        returnResult(res)(err, result);
    });
});

app.get('/api/*/*/charts/*', checkAPICall, function(req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'GET chart data');
    logstream.log('GET chart data', req.params[0], req.params[1]);

    var project = req.params[0];
    var logname = req.params[1];
    var chartname = req.params[2];
    db.getChartData(project, logname, chartname, returnResult(res));
});

app.delete('/api/*/*/charts/*', checkAPICall, function(req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'DELETE chart');
    logstream.log('DELETE chart', req.params[0], req.params[1]);

    var project = req.params[0];
    var logname = req.params[1];
    var chartname = req.params[2];
    db.delChart(project, logname, chartname, returnResult(res, ''));
});

app.post('/api/*/*/charts/*', checkAPICall, function(req, res) {
    console.log('[' + new Date().toLocaleString() + ']', 'POST chart data'); 
    logstream.log('POST chart data', req.params[0], req.params[1]);

    var project = req.params[0];
    var logname = req.params[1];
    var chartname = req.params[2];
    var timestamp = req.body.timestamp || Date.now();
    var chartType = req.body.chartType;
    var data = req.body.data;
    if (!chartType || ['line', 'bar'].indexOf(chartType) >= 0) {
        db.addChartData(project, logname, chartname, timestamp, chartType, data, (err, result) => {
            var appendData = Object.assign({
                chartname: chartname,
                timestamp: timestamp
            }, req.body);
            connections.publish('chart', project, logname, appendData);
            console.log(err, result);
            returnResult(res, req.body)(err, result);
        });   
    }else {
        res.status(400).send({error:'invalid chart type'});
    }
});







// **** bonus time
var intervalID = null;
app.get('/api/open-status-chart', (req, res) => {
    if (!intervalID) {
        intervalID = setInterval(
            () => {
                var branchs = connections.getFocusedBranchs();
                logstream.addChartData('Server-Status', [
                    {key: 'Websocket-Count', value: connections.countSession()},
                    {key: 'Subscriptions-Count', value: connections.countSubscription()},
                    {key: 'Focused-Branch-Count', value: branchs.length}
                ]);
                var branchEmitCount = [];
                for (var i=0; i<branchs.length; i++) {
                    branchEmitCount.push({key: branchs[i], value: connections.getBranchEmitCount(branchs[i])});
                }
                logstream.addChartData('Channel-Emit-Count', branchEmitCount);
            },
            1000
        );
    }
    res.status(200).send();
});

app.get('/api/close-status-chart', (req, res) => {
    if (intervalID) {
        clearInterval(intervalID);
        intervalID = null;
    }
    res.status(200).send();
});

app.get('/api/test', (req, res) => {
    res.status(200).send();
});




/* for login */
app.get('/login',
    passport.authenticate('azuread-openidconnect', { failureRedirect: '/login_failed' }),
    function (req, res) {
        console.log('login ok, redirect!');
        res.redirect('/');
    }
);

app.get('/login_failed', (req, res) => {
    res.send("<h1>You do not have permission!</h1>");
});

app.get('/auth/openid/return',
    passport.authenticate('azuread-openidconnect', { failureRedirect: '/login_failed' }),
    function (req, res) {
        console.log('We received a return from AzureAD. GET');
        res.redirect('/');
    });

app.use(function (req, res) {
    Router.match({ routes: routes.default, location: req.url }, function(err, redirectLocation, renderProps) {
        if (err) {
            res.status(400).send(err.message)
        } else if (redirectLocation) {
            res.status(302).redirect(redirectLocation.pathname + redirectLocation.search)
        } else if (renderProps) {
            if (req.isAuthenticated()) {
                var html = ReactDOMServer.renderToString(React.createElement(Router.RouterContext, renderProps));
                var page = swig.renderFile('views/index.html', { html: html });
                res.cookie('displayName', req.user.displayName);
                res.status(200).send(page);
            }else {
                res.redirect('/login');
            }
        } else {
            res.status(404).send('Page Not Found')
        }
    });
});


var server = http.listen(process.env.PORT || 3333, function() {
    var host = server.address().address;
    var port = server.address().port;

    console.log('Server listening at http://%s:%s', host, port);
});



module.exports = app;