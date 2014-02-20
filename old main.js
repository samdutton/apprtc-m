  var localVideo;
  var miniVideo;
  var remoteVideo;

  var extrasDiv;
  var hangupImg;
  var logoLink;
  var statusDiv;

  var aspectRatio;
  var videoWidth;
  var videoHeight;

  var localStream;
  var remoteStream;
  var channel;
  var channelReady = false;
  var pc;
  var socket;
  var initiator = {{ initiator }};
  var started = false;

  // Set up audio and video regardless of what devices are present.
  var sdpConstraints = {'mandatory': {
    'OfferToReceiveAudio':true,
    'OfferToReceiveVideo':true }};

  // var pc_config = {{ pc_config|safe }};
  var pc_config = {"iceServers": [{"url": "stun:stun.l.google.com:19302"}]};
  // var pc_constraints = {{ pc_constraints|safe }};
  var pc_constraints = {"optional": [{"DtlsSrtpKeyAgreement": true}]};


  var isVideoMuted = false;
  var isAudioMuted = false;

  function initialize() {
    console.log("Initializing; room={{ room_key }}.");

    localVideo = document.getElementById("localVideo");
    localVideo.addEventListener("loadedmetadata", function(){
      videoWidth = this.videoWidth;
      videoHeight = this.videoHeight;
      aspectRatio = videoWidth / videoHeight;
      window.onresize(); // hack :^)
    });

    containerDiv = document.getElementById("container");
    containerDiv.ondblclick = function(){
      this.webkitRequestFullScreen();
    }
    videosDiv = document.getElementById("videos");
    extrasDiv = document.getElementById("extras");
    miniVideo = document.getElementById("miniVideo");
    remoteVideo = document.getElementById("remoteVideo");
    hangupImg = document.getElementById("hangup");
    hangupImg.onclick = function(){onHangup()};
    logoLink = document.getElementById("logo");
    statusDiv = document.getElementById("status");

    resetStatus();
    openChannel('{{ token }}');
   requestTurn('https://computeengineondemand.appspot.com/turn?username=41784574&key=4080218913');
    doGetUserMedia();
    doGetUserMedia();
  }

  function openChannel(channelToken) {
    console.log("Opening channel.");
    var channel = new goog.appengine.Channel(channelToken);
    var handler = {
      'onopen': onChannelOpened,
      'onmessage': onChannelMessage,
      'onerror': onChannelError,
      'onclose': onChannelClosed
    };
    socket = channel.open(handler);
  }

  function requestTurn(turn_url) {
    var turnExists = false;
    for (var i in pc_config.iceServers) {
      if (pc_config.iceServers[i].url.substr(0, 5) == 'turn:') {
        turnExists = true;
        turnReady = true;
        break;
      }
    }
    if (!turnExists) {
      // No turn server. Get one from computeengineondemand.appspot.com:
      xmlhttp = new XMLHttpRequest();
      xmlhttp.onreadystatechange = onTurnResult;
      xmlhttp.open("GET", turn_url, true);
      xmlhttp.send();
    }
  }

  function onTurnResult() {
    if (xmlhttp.readyState == 4 && xmlhttp.status == 200) {
      var turnServer = JSON.parse(xmlhttp.responseText);
      pc_config.iceServers.push({
        "url": "turn:" + turnServer.username + "@" + turnServer.turn,
        "credential": turnServer.password
      });
      turnReady = true;
    }
  }

  function resetStatus() {
    if (!initiator) {
      var url = "{{ room_link }}";
      url = url.replace("\/\/?r", "\/?r"); // when running from localhost
      setStatus("Waiting for someone to join: <a href=\"" + url + "\">" +
        url + "</a>");
    } else {
      setStatus("Initializing...");
    }
  }

  function doGetUserMedia() {
    // Call into getUserMedia via the polyfill (adapter.js).
    var constraints = {{ media_constraints|safe }};
    try {
      getUserMedia({'audio':true, 'video':constraints}, onUserMediaSuccess,
                   onUserMediaError);
      console.log("Requested access to local media with mediaConstraints:\n" +
                  "  \"" + JSON.stringify(constraints) + "\"");
    } catch (e) {
      alert("getUserMedia() failed. Is this a WebRTC capable browser?");
      console.log("getUserMedia failed with exception: " + e.message);
    }
  }

  function createPeerConnection() {
    // Force the use of a number IP STUN server for Firefox.
    if (webrtcDetectedBrowser == "firefox") {
      pc_config = {"iceServers":[{"url":"stun:23.21.150.121"}]};
    }
    try {
      // Create an RTCPeerConnection via the polyfill (adapter.js).
      pc = new RTCPeerConnection(pc_config, pc_constraints);
      pc.onicecandidate = onIceCandidate;
      console.log("Created RTCPeerConnnection with:\n" +
                  "  config: \"" + JSON.stringify(pc_config) + "\";\n" +
                  "  constraints: \"" + JSON.stringify(pc_constraints) + "\".");
    } catch (e) {
      console.log("Failed to create PeerConnection, exception: " + e.message);
      alert("Cannot create RTCPeerConnection object; WebRTC is not supported by this browser.");
        return;
    }

    pc.onaddstream = onRemoteStreamAdded;
    pc.onremovestream = onRemoteStreamRemoved;
  }

  function maybeStart() {
    if (!started && localStream && channelReady) {
      setStatus("Connecting...");
      console.log("Creating PeerConnection.");
      createPeerConnection();
      console.log("Adding local stream.");
      pc.addStream(localStream);
      started = true;
      // Caller initiates offer to peer.
      if (initiator)
        doCall();
    }
  }

  function setStatus(state) {
    if (state === ""){
      statusDiv.classList.remove("active");

    } else {
      statusDiv.classList.add("active");
    }
    statusDiv.innerHTML = state;
  }

  function doCall() {
    // var constraints = {{ offer_constraints | safe }};
    var constraints = {"optional": [], "mandatory": {"MozDontOfferDataChannel": true}};
    // temporary measure to remove Moz* constraints in Chrome
    if (webrtcDetectedBrowser === "chrome") {
      for (prop in constraints.mandatory) {
        if (prop.indexOf("Moz") != -1) {
          delete constraints.mandatory[prop];
        }
       }
     }
    constraints = mergeConstraints(constraints, sdpConstraints);
    console.log("Sending offer to peer, with constraints: \n" +
                "  \"" + JSON.stringify(constraints) + "\".")
    pc.createOffer(setLocalAndSendMessage, null, constraints);
  }

  function doAnswer() {
    console.log("Sending answer to peer.");
    pc.createAnswer(setLocalAndSendMessage, null, sdpConstraints);
  }

  function mergeConstraints(cons1, cons2) {
    var merged = cons1;
    for (var name in cons2.mandatory) {
      merged.mandatory[name] = cons2.mandatory[name];
    }
    merged.optional.concat(cons2.optional);
    return merged;
  }

  function setLocalAndSendMessage(sessionDescription) {
    // Set Opus as the preferred codec in SDP if Opus is present.
    sessionDescription.sdp = preferOpus(sessionDescription.sdp);
    pc.setLocalDescription(sessionDescription);
    sendMessage(sessionDescription);
  }

  function sendMessage(message) {
    var msgString = JSON.stringify(message);
    console.log('C->S: ' + msgString);
    path = '/message?r={{ room_key }}' + '&u={{ me }}';
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.send(msgString);
  }

  function processSignalingMessage(message) {
    var msg = JSON.parse(message);

    if (msg.type === 'offer') {
      // Callee creates PeerConnection
      if (!initiator && !started)
        maybeStart();

      pc.setRemoteDescription(new RTCSessionDescription(msg));
      doAnswer();
    } else if (msg.type === 'answer' && started) {
      pc.setRemoteDescription(new RTCSessionDescription(msg));
    } else if (msg.type === 'candidate' && started) {
      var candidate = new RTCIceCandidate({sdpMLineIndex:msg.label,
                                           candidate:msg.candidate});
      pc.addIceCandidate(candidate);
    } else if (msg.type === 'bye' && started) {
      onRemoteHangup();
    }
  }

  function onChannelOpened() {
    console.log('Channel opened.');
    channelReady = true;
    if (initiator) maybeStart();
  }
  function onChannelMessage(message) {
    console.log('S->C: ' + message.data);
    processSignalingMessage(message.data);
  }
  function onChannelError() {
    console.log('Channel error.');
  }
  function onChannelClosed() {
    console.log('Channel closed.');
  }

  function onUserMediaSuccess(stream) {
    console.log("User has granted access to local media.");
    // Call the polyfill wrapper to attach the media stream to this element.
    attachMediaStream(localVideo, stream);
    localVideo.classList.add("active");
    localStream = stream;
    // Caller creates PeerConnection.
    if (initiator) maybeStart();
  }

  function onUserMediaError(error) {
    console.log("Failed to get access to local media. Error code was " + error.code);
    alert("Failed to get access to local media. Error code was " + error.code + ".");
  }

  function onIceCandidate(event) {
    if (event.candidate) {
      sendMessage({type: 'candidate',
                   label: event.candidate.sdpMLineIndex,
                   id: event.candidate.sdpMid,
                   candidate: event.candidate.candidate});
    } else {
      console.log("End of candidates.");
    }
  }

  function onRemoteStreamAdded(event) {
    console.log("Remote stream added.");
    reattachMediaStream(miniVideo, localVideo);
    attachMediaStream(remoteVideo, event.stream);
    remoteStream = event.stream;
    waitForRemoteVideo();
  }
  function onRemoteStreamRemoved(event) {
    console.log("Remote stream removed.");
  }

  function onHangup() {
    console.log("Hanging up.");
    transitionToDone();
    stop();
    // will trigger BYE from server
    socket.close();
  }

  function onRemoteHangup() {
    console.log('Session terminated.');
    transitionToWaiting();
    stop();
    initiator = 0;
  }

  function stop() {
    started = false;
    isAudioMuted = false;
    isVideoMuted = false;
    pc.close();
    pc = null;
  }

  function waitForRemoteVideo() {
    // Call the getVideoTracks method via adapter.js.
    videoTracks = remoteStream.getVideoTracks();
    if (videoTracks.length === 0 || remoteVideo.currentTime > 0) {
      transitionToActive();
    } else {
      setTimeout(waitForRemoteVideo, 100);
    }
  }
  function transitionToActive() {
    remoteVideo.classList.add("active");
    videosDiv.classList.add("active");
    setTimeout(function() {
      localVideo.src = "";
      localVideo.classList.remove("active");
      extrasDiv.classList.add("active");
      hangupImg.classList.add("active");
      logoLink.classList.add("active");
    }, 1500);
    setStatus("");
    miniVideo.classList.add("active");
  }
  function transitionToWaiting() {
    videosDiv.classList.remove("active");
    setTimeout(function() {
      localVideo.src = miniVideo.src;
      miniVideo.src = "";
      remoteVideo.src = "" }, 500);
    miniVideo.classList.remove("active");
    remoteVideo.remove("active");
    resetStatus();
  }
  function transitionToDone() {
    localVideo.classList.remove("active");
    remoteVideo.classList.remove("active");
    miniVideo.classList.remove("active");
    hangupImg.classList.remove("active");
    logoLink.classList.remove("active");
    setStatus("You have left the call. <a href=\"{{ room_link }}\">Click here</a> to rejoin.");
  }
  function enterFullScreen() {
    container.webkitRequestFullScreen();
  }

  function toggleVideoMute() {
    // Call the getVideoTracks method via adapter.js.
    videoTracks = localStream.getVideoTracks();

    if (videoTracks.length === 0) {
      console.log("No local video available.");
      return;
    }

    if (isVideoMuted) {
      for (i = 0; i < videoTracks.length; i++) {
        videoTracks[i].enabled = true;
      }
      console.log("Video unmuted.");
    } else {
      for (i = 0; i < videoTracks.length; i++) {
        videoTracks[i].enabled = false;
      }
      console.log("Video muted.");
    }

    isVideoMuted = !isVideoMuted;
  }

  function toggleAudioMute() {
    // Call the getAudioTracks method via adapter.js.
    audioTracks = localStream.getAudioTracks();

    if (audioTracks.length === 0) {
      console.log("No local audio available.");
      return;
    }

    if (isAudioMuted) {
      for (i = 0; i < audioTracks.length; i++) {
        audioTracks[i].enabled = true;
      }
      console.log("Audio unmuted.");
    } else {
      for (i = 0; i < audioTracks.length; i++){
        audioTracks[i].enabled = false;
      }
      console.log("Audio muted.");
    }

    isAudioMuted = !isAudioMuted;
  }

  setTimeout(initialize, 1);

  // Send BYE on refreshing(or leaving) a demo page
  // to ensure the room is cleaned for next session.
  window.onbeforeunload = function() {
    sendMessage({type: 'bye'});
  }

  // Ctrl-D: toggle audio mute; Ctrl-E: toggle video mute.
  // On Mac, Command key is instead of Ctrl.
  // Return false to screen out original Chrome shortcuts.
  document.onkeydown = function() {
    if (navigator.appVersion.indexOf("Mac") != -1) {
      if (event.metaKey && event.keyCode === 68) {
        toggleAudioMute();
        return false;
      }
      if (event.metaKey && event.keyCode === 69) {
        toggleVideoMute();
        return false;
      }
    } else {
      if (event.ctrlKey && event.keyCode === 68) {
        toggleAudioMute();
        return false;
      }
      if (event.ctrlKey && event.keyCode === 69) {
        toggleVideoMute();
        return false;
      }
    }
  }

  // Set Opus as the default audio codec if it's present.
  function preferOpus(sdp) {
    var sdpLines = sdp.split('\r\n');

    // Search for m line.
    for (var i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('m=audio') !== -1) {
          var mLineIndex = i;
          break;
        }
    }
    if (mLineIndex === null)
      return sdp;

    // If Opus is available, set it as the default in m line.
    for (var i = 0; i < sdpLines.length; i++) {
      if (sdpLines[i].search('opus/48000') !== -1) {
        var opusPayload = extractSdp(sdpLines[i], /:(\d+) opus\/48000/i);
        if (opusPayload)
          sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex], opusPayload);
        break;
      }
    }

    // Remove CN in m line and sdp.
    sdpLines = removeCN(sdpLines, mLineIndex);

    sdp = sdpLines.join('\r\n');
    return sdp;
  }

  function extractSdp(sdpLine, pattern) {
    var result = sdpLine.match(pattern);
    return (result && result.length == 2)? result[1]: null;
  }

  // Set the selected codec to the first in m line.
  function setDefaultCodec(mLine, payload) {
    var elements = mLine.split(' ');
    var newLine = new Array();
    var index = 0;
    for (var i = 0; i < elements.length; i++) {
      if (index === 3) // Format of media starts from the fourth.
        newLine[index++] = payload; // Put target payload to the first.
      if (elements[i] !== payload)
        newLine[index++] = elements[i];
    }
    return newLine.join(' ');
  }

  // Strip CN from sdp before CN constraints is ready.
  function removeCN(sdpLines, mLineIndex) {
    var mLineElements = sdpLines[mLineIndex].split(' ');
    // Scan from end for the convenience of removing an item.
    for (var i = sdpLines.length-1; i >= 0; i--) {
      var payload = extractSdp(sdpLines[i], /a=rtpmap:(\d+) CN\/\d+/i);
      if (payload) {
        var cnPos = mLineElements.indexOf(payload);
        if (cnPos !== -1) {
          // Remove CN payload from m line.
          mLineElements.splice(cnPos, 1);
        }
        // Remove CN line in sdp
        sdpLines.splice(i, 1);
      }
    }

    sdpLines[mLineIndex] = mLineElements.join(' ');
    return sdpLines;
  }



window.onresize = function(){
  var innerHeight = this.innerHeight;
  var innerWidth = this.innerWidth;
  var videoWidth = innerWidth < aspectRatio * window.innerHeight ? innerWidth :
    aspectRatio * window.innerHeight;
  var videoHeight = innerHeight < window.innerWidth / aspectRatio ? innerHeight :
    window.innerWidth / aspectRatio;

  containerDiv.style.width = videoWidth + "px";
  containerDiv.style.height = videoHeight + "px";
  containerDiv.style.left = (innerWidth - videoWidth) / 2 + "px";
  containerDiv.style.top = (innerHeight - videoHeight) / 2 + "px";
};

</script>

