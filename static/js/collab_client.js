/**
 * This code is mostly from the old Etherpad. Please help us to comment this code. 
 * This helps other people to understand this code better and helps them to improve it.
 * TL;DR COMMENTS ON THIS FILE ARE HIGHLY APPRECIATED
 */

/**
 * Copyright 2009 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var chat = require('/chat').chat;

// Dependency fill on init. This exists for `pad.socket` only.
// TODO: bind directly to the socket.

var pad = undefined;
function getSocket() {
  console.log("DEPRECATED: getSocket()");
  return socket;
}

/* Channel state list:
 *  - CONNECTED    => The client is fully functionnal
 *  - DISCONNECTED => Connection has been definitively lost. Initial state.
 *  - CONNECTING   => The connection is establishing
 *  - RECONNECTING => Connection has been lost but not all hope :)
 *  - RECONNECTED  => Intermediate state between RECONNECTING and CONNECTED
 *
 * Transitions:
 *  - DISCONNECTED -> CONNECTING   => Trying to open initial connection
 *  - CONNECTING   -> CONNECTED    => Initial connexion established
 *  - CONNECTED    -> RECONNECTING => The connection has been lost. Try recover
 *  - CONNECTED    -> DISCONNECTED => The connection has been lost. Give up
 *  - RECONNECTING -> RECONNECTED  => The connection has been recovered
 *  - RECONNECTED  -> CONNECTED    => Connection fully recovered, including pending messages
 */
 
/* Commit state list:
 *  - IDLE      => Changeset connection is idle and allright
 *  - COMMITING => A chaneset is being commited
 *
 * Transitions:
 *  - DISCONNECTED -> CONNECTING   => Trying to open initial connection
 * 
 * Please note that ther is a strong link between "commit state" and "channel state"
 *  - No commit unless channel state == CONNECTED
 *  - Move to DISCONNECT state in case of error situation
 */
 
/*
 * Low level protocol: (very basic)
 *  - Handshake => client/server sync. Done by Socket.io
 *  - Notify Ready => Done right after the connection has been established
 *  - Actual work !
 */

/** Call this when the document is ready, and a new Ace2Editor() has been created and inited.
    ACE's ready callback does not need to have fired yet.
    "serverVars" are from calling doc.getCollabClientVars() on the server. */
function getCollabClient(ace2editor, serverVars, initialUserInfo, options, _pad)
{
  var editor = ace2editor;
  pad = _pad; // Inject pad to avoid a circular dependency.

  var rev = serverVars.rev;
  var padId = serverVars.padId;
  var globalPadId = serverVars.globalPadId;

  var state = "IDLE";
  var stateMessage;
  var stateMessageSocketId;
  var channelState = "CONNECTING";
  var appLevelDisconnectReason = null;

  var lastCommitTime = 0;
  var initialStartConnectTime = 0;

  var userId = initialUserInfo.userId;
  var socketId;
  //var socket;
  var userSet = {}; // userId -> userInfo
  userSet[userId] = initialUserInfo;

  var reconnectTimes = [];
  var caughtErrors = [];
  var caughtErrorCatchers = [];
  var caughtErrorTimes = [];
  var debugMessages = [];

  tellAceAboutHistoricalAuthors(serverVars.historicalAuthorData);
  tellAceActiveAuthorInfo(initialUserInfo);

  var callbacks = {
    onUserJoin: function()
    {},
    onUserLeave: function()
    {},
    onUpdateUserInfo: function()
    {},
    onChannelStateChange: function()
    {},
    onClientMessage: function()
    {},
    onInternalAction: function()
    {},
    onConnectionTrouble: function()
    {},
    onServerMessage: function()
    {}
  };

  if ($.browser.mozilla)
  {
    // Prevent "escape" from taking effect and canceling a comet connection;
    // doesn't work if focus is on an iframe.
    $(window).bind("keydown", function(evt)
    {
      if (evt.which == 27)
      {
        evt.preventDefault()
      }
    });
  }

  editor.setProperty("userAuthor", userId);
  editor.setBaseAttributedText(serverVars.initialAttributedText, serverVars.apool);
  editor.setUserChangeNotificationCallback(wrapRecordingErrors("handleUserChanges", handleUserChanges));
  
  //FIXME: should be moved to an "util" file
  function dmesg(str)
  {
    console.log("dmesg called !");
    if (typeof window.ajlog == "string") window.ajlog += str + '\n';
    debugMessages.push(str);
  }
  
  /* BEGIN SOCKET HANDLING */
  
  //this Function gandles the whole socket life cycle. Cf doc at the top
  function Connection()
  {
    //FIXME: move these to global timeouts constants
    //constants
    var max_delay_between_connection_attempts = 1000*60;//1 min
    var max_connection_attempt_count = 40;//40 attempts before moving to disconnect
    
    //var internal status
    var socket;
    var channelState = "CONNECTING";
    
    //callbacks. One per state.
    var callbacks = {
      onStateConnected:    function(prevState) {},
      onStateDisconnected: function(prevState) {},
      onStateConnecting:   function(prevState) {},
      onStateReconnecting: function(prevState, nextDelay, attemptsCount) {},//very nice for the UI
      onStateReconnected:  function(prevState) {},
      onMessage:           function(obj)       {}
    };
    
    //utils
    
    function getResource()
    {
      //get the page URL
      var loc = document.location;
      //get the correct port
      var port = loc.port == "" ? (loc.protocol == "https:" ? 443 : 80) : loc.port;
      //create the url
      var url = loc.protocol + "//" + loc.hostname + ":" + port + "/";
      //find out in which subfolder we are
      var resource = loc.pathname.substr(1, loc.pathname.indexOf("/p/")) + "socket.io";
      
      return resource;
    }
    
    // Launch actual connection
    channelState = "CONNECTING";
    socket = io.connect(url, {
      resource: getResource(),
      'reconnection limit': max_delay_between_connection_attempts,
      'max reconnection attempts': max_connection_attempt_count,
      'sync disconnect on unload' : false
    });
  
    
    // Internal callbacks
    //event doc here: https://github.com/LearnBoost/socket.io-client
    socket.on('connect', function () {
      console.log("Event: connect. prevstate = "+channelState);
      prevState = channelState;
      if(prevState == "DISCONNECTED")
      {
        channelState = "CONNECTED";
        callbacks.onStateConnected(prevState);//todo handle sendClientReady here
      }
      else
      {
        console.log("BIG ERROR CONDITION");
      }
    });
    
    socket.on('reconnect', function () {
      console.log("Event: connect. prevstate = "+channelState);
      prevState = channelState;
      if(prevState == "RECONNECTING")
      {
        channelState = "RECONNECTED";
        callbacks.onStateReconnected(prevState);//todo handle sendClientReady here
        channelState = "CONNECTED";
        callbacks.onStateConnected("RECONNECTED");
      }
      else
      {
        console.log("BIG ERROR CONDITION");
      }
    });
    
    socket.on('reconnecting', function (nextDelay, attemptsCount) {
      console.log("Event: connect. prevstate = "+channelState);
      prevState = channelState;
      if(prevState == "RECONNECTING" || prevState == "CONNECTED")
      {
        //fixme: check taht list of previous state is OK
        channelState = "RECONNECTING";
        callbacks.onStateReconnecting(prevState, nextDelay, attemptsCount);
      }
      else
      {
        console.log("BIG ERROR CONDITION");
      }
    });
    
    socket.on('connect_failed', function () {
      console.log("Event: connect. prevstate = "+channelState);
      prevState = channelState;
      if(prevState == "RECONNECTING" || prevState == "CONNECTING")
      {
        channelState = "DISCONNECTED";
        callbacks.onStateDisconnected(prevState);
      }
      else
      {
        console.log("BIG ERROR CONDITION");
      }
    });
  
    socket.on('message', function(obj) {
      console.log("Event: message. prevstate = "+channelState);
      callbacks.onMessage(obj);
    });
    
    // Public API
    this.registerCallback = function(name, cb)
    {
      callbacks[name] = cb;
    }
    
    this.forceDisconnect = function()
    {
      socket.disconnect();
      channelState = "DISCONNECTED";
      callbacks.onStateDisconnected(prevState);
    }
    
    this.jsonSend = function(obj)
    {
      socket.json.send(obj);//TODO: state detection
    }
    
    // Bind the colorpicker
    //FIXME: PUT THAT PIECE OF CODE SOMEWHERE. IT IS VALID !
    //var fb = $('#colorpicker').farbtastic({ callback: '#mycolorpickerpreview', width: 220});
  }
  
  /* END SOCKET HANDLING */
  
  /* BEGIN  HANDLING */
  
  //Handles all the protocol logic and the interractions with the connection
  function Protocol(connection)
  {
    //utils
    function getPadId()
    {
      var padId = document.location.pathname.substring(document.location.pathname.lastIndexOf("/") + 1);
      padId = decodeURIComponent(padId); // unescape neccesary due to Safari and Opera interpretation of spaces
      return padId;
    }
    
    //internal API
    function sendMessage(msg)
    {
      connection.jsonSend({
        type: "COLLABROOM",
        component: "pad",
        data: msg
      });
    }
    
    function sendClientReady(isReconnect)
    {
      var padId = getPadId();
      
      if(!isReconnect)
        document.title = padId.replace(/_+/g, ' ') + " | " + document.title;
  
      var token = readCookie("token");      
      var sessionID = readCookie("sessionID");
      var password = readCookie("password");
      
      if (token == null)
      {
        token = "t." + randomString();
        createCookie("token", token, 60);
      }
  
      var msg = {
        "component": "pad",
        "type": "CLIENT_READY",
        "padId": padId,
        "sessionID": sessionID,
        "password": password,
        "token": token,
        "protocolVersion": 2
      };
      
      //this is a reconnect, lets tell the server our revisionnumber
      if(isReconnect == true)
      {
        msg.client_rev=pad.collabClient.getCurrentRevisionNumber();
        msg.reconnect=true;
      }
      
      console.log("sending CLIENT_READY =>");
      console.log(msg);
      connection.jsonSend(msg);
    }
    
    //internal callbacks
    function onStateConnected(prevState)
    {
      //
    }
    
    function onStateDisconnected(prevState)
    {
      //
    }
    
    function onStateConnecting(prevState)
    {
      //
    }
    
    function onStateReconnecting(prevState, nextDelay, attemptsCount)
    {
      //
    }
    
    function onStateReconnected(prevState)
    {
      //
    }
    
    function onMessage(obj)
    {
      //
    }
    
    //register callbacks
    connection.registerCallback("onStateConnected", onStateConnected);
    connection.registerCallback("onStateDisconnected", onStateDisconnected);
    connection.registerCallback("onStateConnecting", onStateConnecting);
    connection.registerCallback("onStateReconnecting", onStateReconnecting);
    connection.registerCallback("onStateReconnected", onStateReconnected);
    connection.registerCallback("onMessage", onMessage);

  }

  /* END PROTOCOL HANDLING */
  
  //Client construction. I love clean and short code :)
  connection = new Connection();
  protocol = new Protocol(connection);

  
  
  // Ran every 3 sec or so. It is responsible for fetching user changes from the 
  // Changeset library and commiting it to the server. It also handles connection 
  // Failure situations
  // Its is very important to notice this "poll" mode
  //  -> prevents server flooding
  //  -> keeps a good isolation with chanset lib
  function handleUserChanges()
  {
    if ((!getSocket()) || channelState == "CONNECTING")
    {
      //max *initial* connection delay = 20s
      if (channelState == "CONNECTING" && (((+new Date()) - initialStartConnectTime) > 20000))
      {
        setChannelState("DISCONNECTED", "initsocketfail");
      }
      else
      {
        // check again in a bit
        setTimeout(wrapRecordingErrors("setTimeout(handleUserChanges)", handleUserChanges), 1000);
      }
      return;
    }

    var t = (+new Date());

    if (state != "IDLE")
    {
      // Commit timeout: 20s 
      if (state == "COMMITTING" && (t - lastCommitTime) > 20000)
      {
        // a commit is taking too long
        setChannelState("DISCONNECTED", "slowcommit");
      }
      else if (state == "COMMITTING" && (t - lastCommitTime) > 5000)
      {
        callbacks.onConnectionTrouble("SLOW");
      }
      else
      {
        // run again in a few seconds, to detect a disconnect
        setTimeout(wrapRecordingErrors("setTimeout(handleUserChanges)", handleUserChanges), 3000);
      }
      return;
    }

    var earliestCommit = lastCommitTime + 500;
    if (t < earliestCommit)
    {
      setTimeout(wrapRecordingErrors("setTimeout(handleUserChanges)", handleUserChanges), earliestCommit - t);
      return;
    }

    var sentMessage = false;
    var userChangesData = editor.prepareUserChangeset();
    if (userChangesData.changeset)
    {
      lastCommitTime = t;
      state = "COMMITTING";
      stateMessage = {
        type: "USER_CHANGES",
        baseRev: rev,
        changeset: userChangesData.changeset,
        apool: userChangesData.apool
      };
      stateMessageSocketId = socketId;
      sendMessage(stateMessage);
      sentMessage = true;
      callbacks.onInternalAction("commitPerformed");
    }

    if (sentMessage)
    {
      // run again in a few seconds, to detect a disconnect
      setTimeout(wrapRecordingErrors("setTimeout(handleUserChanges)", handleUserChanges), 3000);
    }
  }
  
  /* Public collab_client API */
  
  function getStats()
  {
    var stats = {};

    stats.screen = [$(window).width(), $(window).height(), window.screen.availWidth, window.screen.availHeight, window.screen.width, window.screen.height].join(',');
    stats.ip = serverVars.clientIp;
    stats.useragent = serverVars.clientAgent;

    return stats;
  }

  /*
  var hiccupCount = 0;
  function setUpSocket()
  {
    hiccupCount = 0;
    setChannelState("CONNECTED");
    doDeferredActions();

    initialStartConnectTime = +new Date();
  }

  function handleCometHiccup(params)
  {
    dmesg("HICCUP (connected:" + ( !! params.connected) + ")");
    var connectedNow = params.connected;
    if (!connectedNow)
    {
      hiccupCount++;
      // skip first "cut off from server" notification
      if (hiccupCount > 1)
      {
        setChannelState("RECONNECTING");
      }
    }
    else
    {
      hiccupCount = 0;
      setChannelState("CONNECTED");
    }
  }*/
  
  /* Collab_Client utils */
    
  function wrapRecordingErrors(catcher, func)
  {
    return function()
    {
      try
      {
        return func.apply(this, Array.prototype.slice.call(arguments));
      }
      catch (e)
      {
        caughtErrors.push(e);
        caughtErrorCatchers.push(catcher);
        caughtErrorTimes.push(+new Date());
        //console.dir({catcher: catcher, e: e});
        throw e;
      }
    };
  }

  function callCatchingErrors(catcher, func)
  {
    try
    {
      wrapRecordingErrors(catcher, func)();
    }
    catch (e)
    { /*absorb*/
    }
  }
  
  //todo: move to protocol
  function handleMessageFromServer(evt)
  {
    if (window.console) console.log(evt);

    if (!getSocket()) return;
    if (!evt.data) return;
    var wrapper = evt;
    if (wrapper.type != "COLLABROOM") return;
    var msg = wrapper.data;
    if (msg.type == "NEW_CHANGES")
    {
      var newRev = msg.newRev;
      var changeset = msg.changeset;
      var author = (msg.author || '');
      var apool = msg.apool;
      if (newRev != (rev + 1))
      {
        dmesg("bad message revision on NEW_CHANGES: " + newRev + " not " + (rev + 1));
        setChannelState("DISCONNECTED", "badmessage_newchanges");
        return;
      }
      rev = newRev;
      editor.applyChangesToBase(changeset, author, apool);
    }
    else if (msg.type == "ACCEPT_COMMIT")
    {
      var newRev = msg.newRev;
      if (newRev != (rev + 1))
      {
        dmesg("bad message revision on ACCEPT_COMMIT: " + newRev + " not " + (rev + 1));
        setChannelState("DISCONNECTED", "badmessage_acceptcommit");
        return;
      }
      rev = newRev;
      editor.applyPreparedChangesetToBase();
      setStateIdle();
      callCatchingErrors("onInternalAction", function()
      {
        callbacks.onInternalAction("commitAcceptedByServer");
      });
      callCatchingErrors("onConnectionTrouble", function()
      {
        callbacks.onConnectionTrouble("OK");
      });
      handleUserChanges();
    }
    else if (msg.type == "NO_COMMIT_PENDING")
    {
      if (state == "COMMITTING")
      {
        // server missed our commit message; abort that commit
        setStateIdle();
        handleUserChanges();
      }
    }
    else if (msg.type == "USER_NEWINFO")
    {
      var userInfo = msg.userInfo;
      var id = userInfo.userId;
      
      if (userSet[id])
      {
        userSet[id] = userInfo;
        callbacks.onUpdateUserInfo(userInfo);
        dmesgUsers();
      }
      else
      {
        userSet[id] = userInfo;
        callbacks.onUserJoin(userInfo);
        dmesgUsers();
      }
      tellAceActiveAuthorInfo(userInfo);
    }
    else if (msg.type == "USER_LEAVE")
    {
      var userInfo = msg.userInfo;
      var id = userInfo.userId;
      if (userSet[id])
      {
        delete userSet[userInfo.userId];
        fadeAceAuthorInfo(userInfo);
        callbacks.onUserLeave(userInfo);
        dmesgUsers();
      }
    }
    else if (msg.type == "DISCONNECT_REASON")
    {
      appLevelDisconnectReason = msg.reason;
    }
    else if (msg.type == "CLIENT_MESSAGE")
    {
      callbacks.onClientMessage(msg.payload);
    }
    else if (msg.type == "CHAT_MESSAGE")
    {
      chat.addMessage(msg, true);
    }
    else if (msg.type == "SERVER_MESSAGE")
    {
      callbacks.onServerMessage(msg.payload);
    }
  }
  
  //local api
  function updateUserInfo(userInfo)
  {
    userInfo.userId = userId;
    userSet[userId] = userInfo;
    tellAceActiveAuthorInfo(userInfo);
    if (!getSocket()) return;
    sendMessage(
    {
      type: "USERINFO_UPDATE",
      userInfo: userInfo
    });
  }

  //should not be in this file...
  //go to ace or pad with a callback
  function tellAceActiveAuthorInfo(userInfo)
  {
    tellAceAuthorInfo(userInfo.userId, userInfo.colorId);
  }
  
  //idem
  function tellAceAuthorInfo(userId, colorId, inactive)
  {
    if(typeof colorId == "number")
    {
      colorId = clientVars.colorPalette[colorId];
    }
    
    var cssColor = colorId;
    if (inactive)
    {
      editor.setAuthorInfo(userId, {
        bgcolor: cssColor,
        fade: 0.5
      });
    }
    else
    {
      editor.setAuthorInfo(userId, {
        bgcolor: cssColor
      });
    }
  }
  
  //idem
  function fadeAceAuthorInfo(userInfo)
  {
    tellAceAuthorInfo(userInfo.userId, userInfo.colorId, true);
  }

  function getConnectedUsers()
  {
    return valuesArray(userSet);
  }

  function tellAceAboutHistoricalAuthors(hadata)
  {
    for (var author in hadata)
    {
      var data = hadata[author];
      if (!userSet[author])
      {
        tellAceAuthorInfo(author, data.colorId, true);
      }
    }
  }
  
  //may be removed :)
  function dmesgUsers()
  {
    //pad.dmesg($.map(getConnectedUsers(), function(u) { return u.userId.slice(-2); }).join(','));
  }

  //deprecated: remove
  function setChannelState(newChannelState, moreInfo)
  {
    if (newChannelState != channelState)
    {
      channelState = newChannelState;
      callbacks.onChannelStateChange(channelState, moreInfo);
    }
  }
  
  //utils.js
  function keys(obj)
  {
    var array = [];
    $.each(obj, function(k, v)
    {
      array.push(k);
    });
    return array;
  }
  
  //utils.js
  function valuesArray(obj)
  {
    var array = [];
    $.each(obj, function(k, v)
    {
      array.push(v);
    });
    return array;
  }

  // We need to present a working interface even before the socket
  // is connected for the first time.
  var deferredActions = [];

  function defer(func, tag)
  {
    return function()
    {
      var that = this;
      var args = arguments;

      function action()
      {
        func.apply(that, args);
      }
      action.tag = tag;
      if (channelState == "CONNECTING")
      {
        deferredActions.push(action);
      }
      else
      {
        action();
      }
    }
  }

  function doDeferredActions(tag)
  {
    var newArray = [];
    for (var i = 0; i < deferredActions.length; i++)
    {
      var a = deferredActions[i];
      if ((!tag) || (tag == a.tag))
      {
        a();
      }
      else
      {
        newArray.push(a);
      }
    }
    deferredActions = newArray;
  }

  function sendClientMessage(msg)
  {
    sendMessage(
    {
      type: "CLIENT_MESSAGE",
      payload: msg
    });
  }

  function getCurrentRevisionNumber()
  {
    return rev;
  }

  function getMissedChanges()
  {
    var obj = {};
    obj.userInfo = userSet[userId];
    obj.baseRev = rev;
    if (state == "COMMITTING" && stateMessage)
    {
      obj.committedChangeset = stateMessage.changeset;
      obj.committedChangesetAPool = stateMessage.apool;
      obj.committedChangesetSocketId = stateMessageSocketId;
      editor.applyPreparedChangesetToBase();
    }
    var userChangesData = editor.prepareUserChangeset();
    if (userChangesData.changeset)
    {
      obj.furtherChangeset = userChangesData.changeset;
      obj.furtherChangesetAPool = userChangesData.apool;
    }
    return obj;
  }

  function setStateIdle()
  {
    state = "IDLE";
    callbacks.onInternalAction("newlyIdle");
    schedulePerhapsCallIdleFuncs();
  }

  function callWhenNotCommitting(func)
  {
    idleFuncs.push(func);
    schedulePerhapsCallIdleFuncs();
  }

  var idleFuncs = [];

  function schedulePerhapsCallIdleFuncs()
  {
    setTimeout(function()
    {
      if (state == "IDLE")
      {
        while (idleFuncs.length > 0)
        {
          var f = idleFuncs.shift();
          f();
        }
      }
    }, 0);
  }

  var self = {
    setOnUserJoin: function(cb)
    {
      callbacks.onUserJoin = cb;
    },
    setOnUserLeave: function(cb)
    {
      callbacks.onUserLeave = cb;
    },
    setOnUpdateUserInfo: function(cb)
    {
      callbacks.onUpdateUserInfo = cb;
    },
    setOnChannelStateChange: function(cb)
    {
      callbacks.onChannelStateChange = cb;
    },
    setOnClientMessage: function(cb)
    {
      callbacks.onClientMessage = cb;
    },
    setOnInternalAction: function(cb)
    {
      callbacks.onInternalAction = cb;
    },
    setOnConnectionTrouble: function(cb)
    {
      callbacks.onConnectionTrouble = cb;
    },
    setOnServerMessage: function(cb)
    {
      callbacks.onServerMessage = cb;
    },
    updateUserInfo: defer(updateUserInfo),
    handleMessageFromServer: handleMessageFromServer,
    getConnectedUsers: getConnectedUsers,
    sendClientMessage: sendClientMessage,
    sendMessage: sendMessage,
    getCurrentRevisionNumber: getCurrentRevisionNumber,
    getMissedChanges: getMissedChanges,
    callWhenNotCommitting: callWhenNotCommitting,
    addHistoricalAuthors: tellAceAboutHistoricalAuthors,
    setChannelState: setChannelState
  };

  $(document).ready(setUpSocket);
  return self;
}

function selectElementContents(elem)
{
  if ($.browser.msie)
  {
    var range = document.body.createTextRange();
    range.moveToElementText(elem);
    range.select();
  }
  else
  {
    if (window.getSelection)
    {
      var browserSelection = window.getSelection();
      if (browserSelection)
      {
        var range = document.createRange();
        range.selectNodeContents(elem);
        browserSelection.removeAllRanges();
        browserSelection.addRange(range);
      }
    }
  }
}

exports.getCollabClient = getCollabClient;
exports.selectElementContents = selectElementContents;
