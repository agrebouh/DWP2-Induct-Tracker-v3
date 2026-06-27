// ==UserScript==
// @name         DWP2 Induct Tracker v3
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Suivi induction DWP2 - Rate actualisé, avance/retard
// @author       Aghiles
// @match        https://logistics.amazon.co.uk/*
// @match        https://logistics.amazon.fr/*
// @match        https://*.amazon.co.uk/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
'use strict';

// ======== CONFIG ========
var PAUSES = [{start:3.5,end:4},{start:5+22/60,end:5+37/60}];
var NS_END = 5+22/60, HS_START = 5+37/60;
var SLOTS = [];
for(var h=0;h<10;h++) for(var m=0;m<60;m+=15) SLOTS.push(String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'));

// ======== STATE ========
var state = {
    volTotal: parseInt(localStorage.getItem('it3_volTotal'))||30000,
    volNS: parseInt(localStorage.getItem('it3_volNS'))||13500,
    volHS: parseInt(localStorage.getItem('it3_volHS'))||16500,
    rateNS: 0,
    rateHS: 0,
    finHS: parseFloat(localStorage.getItem('it3_finHS'))||8.5,
    totalInducted: 0,
    inductRate: 0,
    held: 0,
    panelOpen: false,
    fullScreen: false,
    station: '',
    timer: null,
    apiKey: null,
    countdown: 60,
    countdownTimer: null,
    showDebug: false,
    _debugInduct: [],
    _debugHeld: {},
    _debugRawInduct: '',
    _debugRawHeld: '',
    snapshots: JSON.parse(localStorage.getItem('it3_snapshots')||'{}'),
    pendingSort: 0,
    stowRate: 0,
    stowWIP: 0,
    stowWIPHistory: JSON.parse(localStorage.getItem('it3_wipHistory')||'[]'),
    _debugStow: '',
    lastSnapshotSlot: '',
    lastResetDate: localStorage.getItem('it3_lastReset')||'',
};

function save(){
    try{
        localStorage.setItem('it3_volTotal',state.volTotal);
        localStorage.setItem('it3_volNS',state.volNS);
        localStorage.setItem('it3_volHS',state.volHS);
        localStorage.setItem('it3_finHS',state.finHS);
    }catch(e){}
}

// ======== INTERCEPT API KEY ========
function interceptKey(){
    try{
        var orig = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function(k,v){
            if(k && k.toLowerCase()==='x-api-usage-key' && v) state.apiKey = v;
            return orig.apply(this, arguments);
        };
    }catch(e){}
}

function getKey(){
    return state.apiKey || 'scc-boson-api-k8x7m2n4p9q1r3s5:1776808103761:SMszXG+e4hj9HfXeAXe5012G+BVpAzu7tYxc6+N0siA=';
}

// ======== DETECT STATION ========
function detectStation(){
    try{
        var saved=localStorage.getItem('it3_station');
        if(saved)return saved;
        var p=new URLSearchParams(window.location.search).get('stationCode');
        if(p)return p;
        var s=localStorage.getItem('selectedStation');
        if(s)return s;
    }catch(e){}
    return 'DWP2';
}

// ======== API ========
function apiPost(path, body, cb){
    var url = window.location.origin + '/station/proxyapigateway/data';
    fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Api-Usage-Key': getKey()
        },
        body: JSON.stringify({
            resourcePath: path,
            httpMethod: 'post',
            processName: body.processName || 'induct',
            requestBody: body.requestBody
        })
    })
    .then(function(r){ return r.json(); })
    .then(cb)
    .catch(function(e){ console.log('[IT3] API error:', path, e.message); });
}

// ======== SNAPSHOT SYSTEM (every 5 min) ========
function getCurrentSlot(){
    var d=new Date();
    var h=d.getHours(), m=d.getMinutes();
    m = Math.floor(m/5)*5;
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

function takeSnapshot(){
    if(state.totalInducted <= 0) return;
    var slot = getCurrentSlot();
    if(slot === state.lastSnapshotSlot) return;
    state.snapshots[slot] = state.totalInducted;
    state.lastSnapshotSlot = slot;
    if(state.stowWIP > 0){
        state.stowWIPHistory.push({time: slot, wip: state.stowWIP});
        if(state.stowWIPHistory.length > 60) state.stowWIPHistory = state.stowWIPHistory.slice(-60);
        try{ localStorage.setItem('it3_wipHistory', JSON.stringify(state.stowWIPHistory)); }catch(e){}
    }
    try{ localStorage.setItem('it3_snapshots', JSON.stringify(state.snapshots)); }catch(e){}
}

function getSlotData(){
    var slots = Object.keys(state.snapshots).sort();
    var result = [];
    for(var i=0;i<slots.length;i++){
        var slotTime = slots[i];
        var cumul = state.snapshots[slotTime];
        var prev = i>0 ? state.snapshots[slots[i-1]] : 0;
        var inductedInSlot = cumul - prev;
        result.push({time: slotTime, inducted: inductedInSlot, cumul: cumul});
    }
    return result;
}

// ======== DAILY RESET ========
function dailyReset(){
    var today = new Date().toDateString();
    if(state.lastResetDate && state.lastResetDate !== today){
        state.totalInducted = 0;
        state.inductRate = 0;
        state.held = 0;
        state.snapshots = {};
        state.lastSnapshotSlot = '';
        state.stowWIPHistory = [];
        state.pendingSort = 0;
        state.stowRate = 0;
        state.stowWIP = 0;
        try{ localStorage.setItem('it3_snapshots', '{}'); localStorage.setItem('it3_wipHistory', '[]'); }catch(e){}
    }
    state.lastResetDate = today;
    try{localStorage.setItem('it3_lastReset', today);}catch(e){}
}

function fetchData(){
    dailyReset();
    var sc = state.station;
    state.countdown = 60;

    apiPost('/ivs/getLocationMetric', {
        processName: 'induct',
        requestBody: { nodeId: sc }
    }, function(d){
        if(d && d.locationInsightList){
            state.totalInducted = d.locationInsightList.reduce(function(s,l){return s+(l.volumeInducted||0);},0);
            state.inductRate = d.locationInsightList.reduce(function(s,l){return s+(l.inductRate||0);},0);
            state._debugInduct = d.locationInsightList.map(function(l){
                return {table: l.locationName||l.locationId||'?', volumeInducted: l.volumeInducted, inductRate: l.inductRate, all_keys: Object.keys(l).join(',')};
            });
            state._debugRawInduct = JSON.stringify(d).substring(0,2000);
            takeSnapshot();
            updateAll();
        } else {
            state._debugInduct = [{error: 'no locationInsightList', raw: JSON.stringify(d).substring(0,500)}];
            updateAll();
        }
    });

    apiPost('/os/getDwellingPackageData', {
        processName: 'oculus',
        requestBody: {
            nodeId: sc, view: 'DWELLING_VIEW',
            filters: [
                {'__type':'TermFilter:http://internal.amazon.com/coral/com.amazon.oculusservice.model.filter/','filterMap':{'SHIPMENT_TYPE':['Delivery']}},
                {'__type':'RangeFilter:http://internal.amazon.com/coral/com.amazon.oculusservice.model.filter/','filterMap':{}}
            ],
            leg: 'FORWARD'
        }
    }, function(d){
        if(d && d.metricResult){
            var hm = d.metricResult.find(function(m){return m.packageStatus==='Held';});
            if(hm && hm.columnToViewDataMap){
                state.held = Object.values(hm.columnToViewDataMap).reduce(function(s,v){return s+(Number(v&&v.value||v)||0);},0);
                state._debugHeld = {columns: Object.keys(hm.columnToViewDataMap), values: Object.entries(hm.columnToViewDataMap).map(function(e){return e[0]+':'+JSON.stringify(e[1]);}).join(' | ')};
            }
            var getTotal = function(map){if(!map)return 0;return Object.values(map).reduce(function(s,v){return s+(Number(v&&v.value||v)||0);},0);};
            var inductedM = d.metricResult.find(function(m){return m.packageStatus==='Inducted';});
            var stowBufM = d.metricResult.find(function(m){return m.packageStatus==='Stow Buffered';});
            state.pendingSort = getTotal(inductedM&&inductedM.columnToViewDataMap) + getTotal(stowBufM&&stowBufM.columnToViewDataMap);
            state._debugRawHeld = JSON.stringify(d).substring(0,2000);
            updateAll();
        } else {
            state._debugHeld = {error: 'no metricResult', raw: JSON.stringify(d).substring(0,500)};
            updateAll();
        }
    });

    fetch(window.location.origin+'/station/flow/stow-wip/data?stationCode='+sc+'&cycleId=CYCLE_1', {
        method: 'GET',
        credentials: 'include',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Api-Usage-Key': getKey()
        }
    }).then(function(r){
        state._debugStow = 'HTTP '+r.status;
        if(!r.ok){
            state._debugStow += ' (not ok) url='+r.url;
            if(state.pendingSort > 0 && state.inductRate > 0){
                state.stowWIP = Math.round((state.pendingSort / state.inductRate) * 60 * 10) / 10;
                state._debugStow += ' | FALLBACK WIP='+state.stowWIP;
            }
            updateAll();
            return null;
        }
        return r.json();
    }).then(function(d){
        if(!d) return;
        state._debugStow += ' | resp='+JSON.stringify(d).substring(0,300);
        if(typeof d.value === 'number'){
            state.stowWIP = d.value;
        } else if(typeof d.stowWip === 'number'){
            state.stowWIP = d.stowWip;
        } else if(typeof d.actual === 'number'){
            state.stowWIP = d.actual;
        } else {
            var keys = Object.keys(d||{});
            state._debugStow += ' | keys='+keys.join(',');
            for(var i=0;i<keys.length;i++){
                if(typeof d[keys[i]] === 'number' && d[keys[i]] > 0 && d[keys[i]] < 100){
                    state.stowWIP = d[keys[i]];
                    state._debugStow += ' | used key='+keys[i];
                    break;
                }
            }
        }
        updateAll();
    }).catch(function(e){
        state._debugStow = 'CATCH: '+e.message;
        if(state.pendingSort > 0 && state.inductRate > 0){
            state.stowWIP = Math.round((state.pendingSort / state.inductRate) * 60 * 10) / 10;
            state._debugStow += ' | FALLBACK WIP='+state.stowWIP;
        }
        updateAll();
    });

    fetch(window.location.origin+'/station/flow/sort/data?stationCode='+sc+'&cycleId=CYCLE_1', {
        method: 'GET',
        credentials: 'include',
        headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Api-Usage-Key': getKey()
        }
    }).then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
        if(d && typeof d.value === 'number'){
            state.stowRate = d.value;
        }
    }).catch(function(e){});
}

// ======== CALCULATIONS ========
function now(){var d=new Date();return d.getHours()+d.getMinutes()/60+d.getSeconds()/3600;}
function effTime(s,e){var t=e-s;PAUSES.forEach(function(p){var os=Math.max(s,p.start),oe=Math.min(e,p.end);if(oe>os)t-=(oe-os);});return Math.max(0,t);}
function fmt(h){if(h<=0||!isFinite(h))return'--:--';return Math.floor(h)+'h'+String(Math.round((h%1)*60)).padStart(2,'0');}
function hhmm(d){return String(Math.floor(d)).padStart(2,'0')+':'+String(Math.round((d%1)*60)).padStart(2,'0');}

function calc(){
    var n=now(),c=state.totalInducted,vT=state.volTotal,vN=state.volNS,vH=state.volHS,fH=state.finHS;

    var rN = vN / 4.8;
    var hsEffTotal = fH - (5+37/60);
    var rH = hsEffTotal > 0.01 ? vH / hsEffTotal : 0;

    var TRANCHES = [
        {start:0+10/60, end:1,      dur:50, shift:'NS', rate:rN},
        {start:1,       end:2,      dur:60, shift:'NS', rate:rN},
        {start:2,       end:3,      dur:60, shift:'NS', rate:rN},
        {start:3,       end:3.5,    dur:30, shift:'NS', rate:rN},
        {start:3+55/60, end:5,      dur:65, shift:'NS', rate:rN},
        {start:5,       end:5+22/60,dur:22, shift:'NS', rate:rN}
    ];

    var hsStart = 5+37/60;
    var hsHour = 6;
    TRANCHES.push({start:hsStart, end:6, dur:23, shift:'HS', rate:rH});
    while(hsHour < Math.floor(fH)){
        TRANCHES.push({start:hsHour, end:hsHour+1, dur:60, shift:'HS', rate:rH});
        hsHour++;
    }
    if(fH > Math.floor(fH)){
        var lastDur = Math.round((fH - Math.floor(fH)) * 60);
        TRANCHES.push({start:Math.floor(fH), end:fH, dur:lastDur, shift:'HS', rate:rH});
    }

    var tgtNow = 0;
    for(var i=0; i<TRANCHES.length; i++){
        var tr = TRANCHES[i];
        var targetTranche = Math.round(tr.rate * tr.dur / 60);
        if(n >= tr.end){
            tgtNow += targetTranche;
        } else if(n > tr.start){
            var elapsed = (n - tr.start) * 60;
            tgtNow += Math.round(tr.rate * elapsed / 60);
            break;
        } else {
            break;
        }
    }

    var delta = c - tgtNow;
    var rem = Math.max(0, vT - c);

    var nsI = n <= NS_END ? c : (state.snapshots && state.snapshots['05:15'] ? state.snapshots['05:15'] : Math.round(vN));
    var hsI = Math.max(0, c - nsI);

    var volHSPratique = n > NS_END ? Math.max(0, vT - nsI) : vH;

    var nsTL = 0, hsTL = 0;
    for(var i=0; i<TRANCHES.length; i++){
        var tr = TRANCHES[i];
        if(tr.shift === 'NS' && tr.end > n){
            nsTL += (tr.end - Math.max(n, tr.start));
        }
        if(tr.shift === 'HS' && tr.end > n){
            hsTL += (tr.end - Math.max(n, tr.start));
        }
    }

    var nsRem = Math.max(0, vN - nsI);
    var hsRem = Math.max(0, volHSPratique - hsI);
    var nsRN = nsTL > 0.01 ? Math.round(nsRem / nsTL) : 0;
    var hsRN = hsTL > 0.01 ? Math.round(hsRem / hsTL) : 0;

    var liveRate = state.inductRate || 0;
    var eta = '--:--', etaOk = false;
    if(liveRate > 0 && rem > 0){var ed = n + rem / liveRate; eta = hhmm(ed); etaOk = ed <= fH;}
    else if(rem <= 0 && c > 0){eta = '\u2713 Fini'; etaOk = true;}
    var pct = vT > 0 ? Math.round(c / vT * 100) : 0;

    return{c:c, rem:rem, pct:pct, delta:delta, eta:eta, etaOk:etaOk,
           nsI:nsI, hsI:hsI, volHSPratique:volHSPratique,
           rN:Math.round(rN), rH:Math.round(rH),
           nsRN:nsRN, hsRN:hsRN, nsTL:nsTL, hsTL:hsTL,
           oR:0, liveRate:Math.round(liveRate)};
}

function updateAll(){ updatePanel(); updateFullScreen(); showDebugPanel(); }

// ======== COMPACT OVERLAY PANEL ========
function createButton(){
    if(!document.body){setTimeout(createButton,500);return;}
    if(document.getElementById('it3-btn'))return;
    var b=document.createElement('div');
    b.id='it3-btn';
    b.textContent='\u26A1';
    b.title='Clic = panneau | Double-clic = plein \u00e9cran';
    b.style.cssText='position:fixed;bottom:20px;right:20px;width:56px;height:56px;background:linear-gradient(135deg,#2563eb,#1e40af);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 20px rgba(37,99,235,0.5);z-index:2147483647;font-size:24px;color:white;user-select:none;';
    b.onmouseenter=function(){b.style.transform='scale(1.15)';};
    b.onmouseleave=function(){b.style.transform='scale(1)';};
    b.onclick=function(){if(state.panelOpen)closePanel();else openPanel();};
    b.ondblclick=function(e){e.preventDefault();closePanel();openFullScreen();};
    document.body.appendChild(b);
}

function openPanel(){
    state.panelOpen=true;
    buildPanel();
    fetchData();
    startTimers();
}

function closePanel(){
    state.panelOpen=false;
    var p=document.getElementById('it3-panel');if(p)p.remove();
    stopTimers();
}

function startTimers(){
    stopTimers();
    state.timer=setInterval(fetchData,60000);
    state.countdownTimer=setInterval(function(){
        state.countdown=Math.max(0,state.countdown-1);
        var ce=document.getElementById('it3-upd');if(ce)ce.textContent='Refresh: '+state.countdown+'s';
        var cef=document.getElementById('fs-countdown');if(cef)cef.textContent='Refresh: '+state.countdown+'s';
    },1000);
}
function stopTimers(){
    if(state.timer){clearInterval(state.timer);state.timer=null;}
    if(state.countdownTimer){clearInterval(state.countdownTimer);state.countdownTimer=null;}
}

function buildPanel(){
    var old=document.getElementById('it3-panel');if(old)old.remove();
    var fh=hhmm(state.finHS);
    var p=document.createElement('div');
    p.id='it3-panel';
    p.style.cssText='position:fixed;top:10px;right:10px;width:370px;background:#1a1f36;color:#e2e8f0;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:12px;overflow:hidden;';
    p.innerHTML='<div style="background:linear-gradient(135deg,#2563eb,#1e40af);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;"><span style="font-size:13px;font-weight:600;color:#fff;">\u26A1 Induct Tracker</span><div style="display:flex;align-items:center;gap:8px;"><span id="it3-clock" style="font-size:11px;color:#93c5fd;font-family:monospace;"></span><span id="it3-dbg-btn" style="cursor:pointer;color:#f59e0b;font-size:11px;font-weight:bold;background:#1e293b;padding:2px 6px;border-radius:4px;" title="Debug API">DBG</span><span id="it3-fs-btn" style="cursor:pointer;color:#93c5fd;font-size:14px;" title="Plein \u00e9cran">\u26F6</span><span id="it3-close" style="cursor:pointer;color:#93c5fd;font-size:16px;">\u2715</span></div></div>'
    +'<div style="padding:12px;">'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #2d3748;"><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Station</div><select id="it3-station" style="flex:1;padding:3px 5px;border:1px solid #374151;border-radius:3px;background:#111827;color:#e2e8f0;font-size:11px;font-family:monospace;"><option value="DWP2"'+(state.station==="DWP2"?" selected":"")+'>DWP2</option><option value="DWP1"'+(state.station==="DWP1"?" selected":"")+'>DWP1</option><option value="DWP3"'+(state.station==="DWP3"?" selected":"")+'>DWP3</option><option value="DWP4"'+(state.station==="DWP4"?" selected":"")+'>DWP4</option></select><span style="font-size:9px;color:#64748b;">(actuel: <b style="color:#4ade80;">'+state.station+'</b>)</span></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #2d3748;">'
    +'<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Vol Total</div><input id="it3-vt" type="number" value="'+state.volTotal+'" style="width:100%;padding:3px 5px;border:1px solid #374151;border-radius:3px;background:#111827;color:#e2e8f0;font-size:11px;font-family:monospace;box-sizing:border-box;"></div>'
    +'<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Vol NS</div><input id="it3-vn" type="number" value="'+state.volNS+'" style="width:100%;padding:3px 5px;border:1px solid #374151;border-radius:3px;background:#111827;color:#e2e8f0;font-size:11px;font-family:monospace;box-sizing:border-box;"></div>'
    +'<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Vol HS (auto)</div><input id="it3-vh" type="number" value="'+state.volHS+'" style="width:100%;padding:3px 5px;border:1px solid #374151;border-radius:3px;background:#0f172a;color:#34d399;font-size:11px;font-family:monospace;box-sizing:border-box;" readonly></div>'
    +'<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Rate NS (auto)</div><div id="it3-rn-disp" style="padding:3px 5px;background:#0f172a;border-radius:3px;color:#34d399;font-size:11px;font-family:monospace;text-align:center;">\u2014</div></div>'
    +'<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Rate HS (auto)</div><div id="it3-rh-disp" style="padding:3px 5px;background:#0f172a;border-radius:3px;color:#34d399;font-size:11px;font-family:monospace;text-align:center;">\u2014</div></div>'
    +'<div><div style="font-size:9px;color:#64748b;text-transform:uppercase;">Fin HS</div><input id="it3-fh" type="time" value="'+fh+'" style="width:100%;padding:3px 5px;border:1px solid #374151;border-radius:3px;background:#111827;color:#e2e8f0;font-size:11px;font-family:monospace;box-sizing:border-box;"></div>'
    +'</div>'
    +'<div id="it3-delta" style="padding:8px;border-radius:6px;text-align:center;font-size:14px;font-weight:700;font-family:monospace;margin-bottom:8px;background:#1e293b;color:#64748b;border:1px solid #334155;">\u23F3 Chargement...</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">'
    +'<div style="text-align:center;padding:6px;background:#111827;border-radius:6px;border:1px solid #1e293b;"><div style="font-size:9px;color:#64748b;">INDUCT\u00c9</div><div id="it3-cum" style="font-size:15px;font-weight:700;font-family:monospace;color:#60a5fa;">0</div></div>'
    +'<div style="text-align:center;padding:6px;background:#111827;border-radius:6px;border:1px solid #1e293b;"><div style="font-size:9px;color:#64748b;">RESTANT</div><div id="it3-rem" style="font-size:15px;font-weight:700;font-family:monospace;color:#fbbf24;">0</div></div>'
    +'<div style="text-align:center;padding:6px;background:#111827;border-radius:6px;border:1px solid #1e293b;"><div style="font-size:9px;color:#64748b;">PROGRESS</div><div id="it3-pct" style="font-size:15px;font-weight:700;font-family:monospace;color:#34d399;">0%</div></div>'
    +'</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">'
    +'<div style="text-align:center;padding:6px;background:#111827;border-radius:6px;border:1px solid #1e293b;"><div style="font-size:9px;color:#64748b;">ETA FIN</div><div id="it3-eta" style="font-size:15px;font-weight:700;font-family:monospace;color:#94a3b8;">--:--</div></div>'
    +'<div style="text-align:center;padding:6px;background:#111827;border-radius:6px;border:1px solid #1e293b;"><div style="font-size:9px;color:#64748b;">HELD</div><div id="it3-held" style="font-size:15px;font-weight:700;font-family:monospace;color:#f87171;">0</div></div>'
    +'<div style="text-align:center;padding:6px;background:#111827;border-radius:6px;border:1px solid #1e293b;"><div style="font-size:9px;color:#64748b;">RATE LIVE</div><div id="it3-rate" style="font-size:15px;font-weight:700;font-family:monospace;color:#60a5fa;">0</div></div>'
    +'</div>'
    +'<div style="padding:7px;border-radius:5px;margin-bottom:5px;background:#0f172a;border-left:3px solid #3b82f6;"><div style="font-size:10px;font-weight:600;color:#60a5fa;margin-bottom:4px;">\uD83C\uDF19 NIGHT SORT (00:00\u201305:22)</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;text-align:center;"><div><div style="font-size:8px;color:#64748b;">INDUCT\u00c9</div><div id="it3-nsa" style="font-size:12px;font-weight:600;font-family:monospace;color:#60a5fa;">\u2014</div></div><div><div style="font-size:8px;color:#64748b;">N\u00c9CESSAIRE</div><div id="it3-nsn" style="font-size:12px;font-weight:600;font-family:monospace;color:#f87171;">\u2014</div></div><div><div style="font-size:8px;color:#64748b;">RESTANT</div><div id="it3-nst" style="font-size:12px;font-weight:600;font-family:monospace;color:#94a3b8;">\u2014</div></div></div></div>'
    +'<div style="padding:7px;border-radius:5px;margin-bottom:5px;background:#1a0f0a;border-left:3px solid #f97316;"><div style="font-size:10px;font-weight:600;color:#fb923c;margin-bottom:4px;">\u2600\uFE0F HYBRIDE (05:37\u2013'+fh+')</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;text-align:center;"><div><div style="font-size:8px;color:#64748b;">INDUCT\u00c9</div><div id="it3-hsa" style="font-size:12px;font-weight:600;font-family:monospace;color:#fb923c;">\u2014</div></div><div><div style="font-size:8px;color:#64748b;">N\u00c9CESSAIRE</div><div id="it3-hsn" style="font-size:12px;font-weight:600;font-family:monospace;color:#f87171;">\u2014</div></div><div><div style="font-size:8px;color:#64748b;">RESTANT</div><div id="it3-hst" style="font-size:12px;font-weight:600;font-family:monospace;color:#94a3b8;">\u2014</div></div></div></div>'
    +'<div style="font-size:10px;color:#475569;text-align:center;padding-top:5px;border-top:1px solid #1e293b;">Station: <b>'+state.station+'</b> | <span id="it3-upd">\u2014</span> <span id="it3-ref" style="cursor:pointer;padding:1px 6px;background:#374151;border-radius:3px;margin-left:4px;">\uD83D\uDD04</span></div>'
    +'</div>';
    document.body.appendChild(p);

    document.getElementById('it3-close').onclick=closePanel;
    document.getElementById('it3-fs-btn').onclick=function(){closePanel();openFullScreen();};
    document.getElementById('it3-dbg-btn').onclick=function(){state.showDebug=!state.showDebug;showDebugPanel();};
    document.getElementById('it3-ref').onclick=fetchData;
    bindConfigInputs('it3');
    setInterval(function(){var e=document.getElementById('it3-clock');if(e)e.textContent=new Date().toLocaleTimeString('fr-FR');},1000);
}

function bindConfigInputs(prefix){
    ['vt','vn','vh'].forEach(function(suf){
        var id=prefix+'-'+suf;
        var el=document.getElementById(id);
        if(!el)return;
        el.onchange=function(){
            state.volTotal=parseInt(document.getElementById(prefix+'-vt').value)||0;
            state.volNS=parseInt(document.getElementById(prefix+'-vn').value)||0;
            state.volHS=Math.max(0, state.volTotal - state.volNS);
            document.getElementById(prefix+'-vh').value=state.volHS;
            save();updateAll();
        };
    });
    var fhEl=document.getElementById(prefix+'-fh');
    if(fhEl) fhEl.onchange=function(){var v=this.value.split(':').map(Number);state.finHS=v[0]+v[1]/60;save();updateAll();};
    var stEl=document.getElementById(prefix.replace('it3','it3')+'-station') || document.getElementById('it3-station');
    if(stEl) stEl.onchange=function(){
        state.station=this.value;
        try{localStorage.setItem('it3_station',this.value);}catch(e){}
        fetchData();
    };
}

function updatePanel(){
    if(!state.panelOpen)return;
    var r=calc();
    var el=function(id){return document.getElementById(id);};
    if(!el('it3-cum'))return;
    el('it3-cum').textContent=r.c.toLocaleString();
    el('it3-rem').textContent=r.rem.toLocaleString();
    el('it3-pct').textContent=r.pct+'%';
    el('it3-eta').textContent=r.eta;
    el('it3-eta').style.color=r.etaOk?'#34d399':'#f87171';
    el('it3-held').textContent=state.held.toLocaleString();
    el('it3-rate').textContent=r.liveRate.toLocaleString()+'/h';
    var bar=el('it3-delta');
    if(r.c>0){
        if(r.delta>0){bar.style.background='#052e16';bar.style.color='#34d399';bar.style.borderColor='#166534';bar.textContent='\u25B2 EN AVANCE : +'+r.delta.toLocaleString()+' colis';}
        else if(r.delta<0){bar.style.background='#2d0a0a';bar.style.color='#f87171';bar.style.borderColor='#7f1d1d';bar.textContent='\u25BC EN RETARD : '+r.delta.toLocaleString()+' colis';}
        else{bar.style.background='#1e293b';bar.style.color='#94a3b8';bar.textContent='= DANS LES TEMPS';}
    }
    el('it3-nsa').textContent=r.nsI>0?r.nsI.toLocaleString():'\u2014';
    el('it3-nsn').textContent=r.nsRN>0?r.nsRN.toLocaleString()+'/h':'\u2014';
    el('it3-nsn').style.color=r.nsRN<=r.rN?'#34d399':'#f87171';
    el('it3-nst').textContent=fmt(r.nsTL);
    el('it3-hsa').textContent=r.hsI>0?r.hsI.toLocaleString():'\u2014';
    el('it3-hsn').textContent=r.hsRN>0?r.hsRN.toLocaleString()+'/h':'\u2014';
    el('it3-hsn').style.color=r.hsRN<=r.rH?'#34d399':'#f87171';
    el('it3-hst').textContent=fmt(r.hsTL);
    var rnDisp=document.getElementById('it3-rn-disp');
    var rhDisp=document.getElementById('it3-rh-disp');
    if(rnDisp) rnDisp.textContent=r.rN>0?r.rN.toLocaleString()+'/h':'\u2014';
    if(rhDisp) rhDisp.textContent=r.rH>0?r.rH.toLocaleString()+'/h':'\u2014';
}

function showDebugPanel(){
    var old=document.getElementById('it3-debug');if(old)old.remove();
    if(!state.showDebug)return;
    var d=document.createElement('div');
    d.id='it3-debug';
    d.style.cssText='position:fixed;top:10px;left:10px;width:500px;max-height:90vh;overflow:auto;background:#0f172a;color:#e2e8f0;border:2px solid #f59e0b;border-radius:8px;padding:12px;z-index:2147483647;font-family:monospace;font-size:11px;';
    var h='<div style="color:#f59e0b;font-weight:bold;margin-bottom:8px;">\uD83D\uDD27 DEBUG API - Donn\u00e9es brutes</div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;"><b style="color:#38bdf8;">Station:</b> '+state.station+'</div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;"><b style="color:#38bdf8;">API Key:</b> '+(state.apiKey?state.apiKey.substring(0,30)+'...':'FALLBACK')+'</div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;"><b style="color:#38bdf8;">INDUCT API (/ivs/getLocationMetric):</b><br>';
    h+='totalInducted (sum volumeInducted) = <b style="color:#4ade80;">'+state.totalInducted+'</b><br>';
    h+='inductRate (sum) = <b style="color:#4ade80;">'+state.inductRate+'</b><br>';
    h+='Held = <b style="color:#4ade80;">'+state.held+'</b><br>';
    h+='<br><b>Par table:</b><br>';
    if(state._debugInduct && state._debugInduct.length){
        state._debugInduct.forEach(function(t,i){
            h+='  Table '+(i+1)+': '+JSON.stringify(t)+'<br>';
        });
    } else { h+='  (pas de donn\u00e9es)<br>'; }
    h+='</div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;"><b style="color:#38bdf8;">HELD API (/os/getDwellingPackageData):</b><br>';
    h+=JSON.stringify(state._debugHeld||{})+'</div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;"><b style="color:#38bdf8;">RAW Induct (2000 chars):</b><br><pre style="white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;">'+((state._debugRawInduct||'').replace(/</g,'&lt;'))+'</pre></div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;"><b style="color:#38bdf8;">RAW Held (2000 chars):</b><br><pre style="white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;">'+((state._debugRawHeld||'').replace(/</g,'&lt;'))+'</pre></div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;border:2px solid #fb923c;"><b style="color:#fb923c;">STOW WIP:</b><br>stowRate='+state.stowRate+' | pendingSort='+state.pendingSort+' | stowWIP='+state.stowWIP+'<br>debug: '+(state._debugStow||'(no data)')+'</div>';
    h+='<div style="margin-bottom:8px;padding:6px;background:#1e293b;border-radius:4px;border:2px solid #22c55e;"><b style="color:#22c55e;">SNAPSHOTS (5-min):</b><br><pre style="white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;">'+JSON.stringify(state.snapshots, null, 1)+'</pre></div>';
    h+='<div style="text-align:center;margin-top:8px;"><button onclick="document.getElementById(\'it3-debug\').remove();state.showDebug=false;" style="background:#f59e0b;color:#000;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:bold;">Fermer Debug</button></div>';
    d.innerHTML=h;
    document.body.appendChild(d);
}

// ======== FULL SCREEN DASHBOARD ========
function openFullScreen(){
    state.fullScreen=true;
    var all=document.body.children;
    for(var i=0;i<all.length;i++){
        if(all[i].id!=='it3-btn'&&all[i].id!=='it3-fullscreen'){
            all[i].setAttribute('data-it3-hidden','1');
            all[i].style.display='none';
        }
    }
    buildFullScreen();
    fetchData();
    startTimers();
}

function closeFullScreen(){
    state.fullScreen=false;
    var fs=document.getElementById('it3-fullscreen');if(fs)fs.remove();
    var hidden=document.querySelectorAll('[data-it3-hidden]');
    for(var i=0;i<hidden.length;i++){
        hidden[i].style.display='';
        hidden[i].removeAttribute('data-it3-hidden');
    }
    stopTimers();
}

function buildFullScreen(){
    var old=document.getElementById('it3-fullscreen');if(old)old.remove();
    var fh=hhmm(state.finHS);
    var fs=document.createElement('div');
    fs.id='it3-fullscreen';
    fs.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:#0f172a;color:#e2e8f0;z-index:2147483646;overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:0;';

    var html = '';
    html+='<div style="background:linear-gradient(135deg,#1e40af,#1e3a5f);padding:14px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10;">';
    html+='<span style="font-size:18px;font-weight:700;color:#fff;">\u26A1 Induct Tracker \u2014 DWP2</span>';
    html+='<div style="display:flex;align-items:center;gap:16px;">';
    html+='<span id="fs-clock" style="font-size:14px;color:#93c5fd;font-family:monospace;"></span>';
    html+='<span id="fs-close" style="cursor:pointer;color:#93c5fd;font-size:14px;padding:6px 14px;border:1px solid #3b82f6;border-radius:6px;">\u2715 Fermer</span>';
    html+='</div></div>';

    html+='<div style="padding:20px 24px;max-width:1400px;margin:0 auto;">';

    html+='<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px;background:#1e293b;padding:14px;border-radius:10px;border:1px solid #334155;">';
    var fields=[{l:'Volume Total',id:'fs-vt',v:state.volTotal,t:'number'},{l:'Volume NS',id:'fs-vn',v:state.volNS,t:'number'},{l:'Volume HS',id:'fs-vh',v:state.volHS,t:'number'},{l:'Rate NS/h',id:'fs-rn',v:state.rateNS,t:'number'},{l:'Rate HS/h',id:'fs-rh',v:state.rateHS,t:'number'},{l:'Fin HS',id:'fs-fh',v:fh,t:'time'}];
    fields.forEach(function(f){
        html+='<div><div style="font-size:10px;color:#64748b;text-transform:uppercase;margin-bottom:3px;">'+f.l+'</div><input id="'+f.id+'" type="'+f.t+'" value="'+f.v+'" style="width:100%;padding:8px 10px;border:1px solid #374151;border-radius:5px;background:#0f172a;color:#e2e8f0;font-size:14px;font-family:monospace;box-sizing:border-box;"></div>';
    });
    html+='</div>';

    html+='<div id="fs-delta" style="padding:14px;border-radius:10px;text-align:center;font-size:22px;font-weight:700;font-family:monospace;margin-bottom:16px;background:#1e293b;color:#64748b;border:1px solid #334155;">\u23F3 Chargement des donn\u00e9es...</div>';

    html+='<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:16px;">';
    var kpis=[{l:'INDUCT\u00c9',id:'fs-cum',col:'#60a5fa'},{l:'RESTANT',id:'fs-rem',col:'#fbbf24'},{l:'PROGRESSION',id:'fs-pct',col:'#34d399'},{l:'ETA FIN',id:'fs-eta',col:'#94a3b8'},{l:'HELD',id:'fs-held',col:'#f87171'},{l:'RATE LIVE',id:'fs-rate',col:'#60a5fa'}];
    kpis.forEach(function(k){
        html+='<div style="text-align:center;padding:14px;background:#1e293b;border-radius:10px;border:1px solid #334155;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;margin-bottom:6px;">'+k.l+'</div><div id="'+k.id+'" style="font-size:26px;font-weight:700;font-family:monospace;color:'+k.col+';">\u2014</div></div>';
    });
    html+='</div>';

    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px;">';
    html+='<div style="padding:16px;border-radius:10px;background:#1e293b;border:1px solid #334155;border-left:4px solid #3b82f6;">';
    html+='<div style="font-size:13px;font-weight:600;color:#60a5fa;margin-bottom:10px;">\uD83C\uDF19 Night Sort (00:00 \u2013 05:22)</div>';
    html+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;text-align:center;">';
    html+='<div><div style="font-size:10px;color:#64748b;">INDUCT\u00c9</div><div id="fs-nsa" style="font-size:20px;font-weight:700;font-family:monospace;color:#60a5fa;">\u2014</div></div>';
    html+='<div><div style="font-size:10px;color:#64748b;">RATE N\u00c9CESSAIRE</div><div id="fs-nsn" style="font-size:20px;font-weight:700;font-family:monospace;color:#f87171;">\u2014</div></div>';
    html+='<div><div style="font-size:10px;color:#64748b;">TEMPS RESTANT</div><div id="fs-nst" style="font-size:20px;font-weight:700;font-family:monospace;color:#94a3b8;">\u2014</div></div>';
    html+='</div></div>';
    html+='<div style="padding:16px;border-radius:10px;background:#1e293b;border:1px solid #334155;border-left:4px solid #f97316;">';
    html+='<div style="font-size:13px;font-weight:600;color:#fb923c;margin-bottom:10px;">\u2600\uFE0F Hybride (05:37 \u2013 '+fh+')</div>';
    html+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;text-align:center;">';
    html+='<div><div style="font-size:10px;color:#64748b;">INDUCT\u00c9</div><div id="fs-hsa" style="font-size:20px;font-weight:700;font-family:monospace;color:#fb923c;">\u2014</div></div>';
    html+='<div><div style="font-size:10px;color:#64748b;">RATE N\u00c9CESSAIRE</div><div id="fs-hsn" style="font-size:20px;font-weight:700;font-family:monospace;color:#f87171;">\u2014</div></div>';
    html+='<div><div style="font-size:10px;color:#64748b;">TEMPS RESTANT</div><div id="fs-hst" style="font-size:20px;font-weight:700;font-family:monospace;color:#94a3b8;">\u2014</div></div>';
    html+='</div></div>';
    html+='</div>';

    html+='<div style="background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px;margin-bottom:16px;">';
    html+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">';
    html+='<div style="font-size:13px;font-weight:600;color:#94a3b8;">\uD83D\uDCE6 Stow WIP</div>';
    html+='<div style="display:flex;gap:8px;align-items:center;">';
    html+='<span style="font-size:10px;color:#64748b;">Min: 10</span>';
    html+='<span style="font-size:10px;color:#64748b;">Max: 19</span>';
    html+='</div></div>';
    html+='<div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;">';
    html+='<div id="fs-wip-value" style="font-size:36px;font-weight:700;font-family:monospace;color:#94a3b8;">\u2014</div>';
    html+='<div style="flex:1;">';
    html+='<div style="position:relative;height:20px;background:#0f172a;border-radius:10px;overflow:hidden;">';
    html+='<div style="position:absolute;left:'+(10/30*100)+'%;width:'+((19-10)/30*100)+'%;height:100%;background:rgba(34,197,94,0.15);border-left:2px solid #22c55e;border-right:2px solid #22c55e;"></div>';
    html+='<div id="fs-wip-bar" style="position:absolute;left:0;height:100%;width:0%;background:#60a5fa;border-radius:10px;transition:width 0.5s;"></div>';
    html+='</div>';
    html+='<div style="display:flex;justify-content:space-between;margin-top:2px;"><span style="font-size:9px;color:#475569;">0</span><span style="font-size:9px;color:#22c55e;">10</span><span style="font-size:9px;color:#22c55e;">19</span><span style="font-size:9px;color:#475569;">30+</span></div>';
    html+='</div></div>';
    html+='<div id="fs-wip-alert" style="padding:8px 12px;border-radius:6px;font-size:12px;font-weight:500;margin-bottom:12px;display:none;"></div>';
    html+='<div style="font-size:10px;color:#64748b;margin-bottom:4px;">Historique WIP (5 min)</div>';
    html+='<div id="fs-wip-graph" style="height:50px;display:flex;align-items:flex-end;gap:1px;"></div>';
    html+='</div>';

    html+='<div style="background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px;margin-bottom:16px;">';
    html+='<div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:12px;">\u2696\uFE0F Flow Balance (Induct vs Sort)</div>';
    html+='<div style="display:flex;align-items:center;gap:16px;">';
    html+='<div style="flex:1;text-align:center;"><div style="font-size:10px;color:#64748b;">INDUCT RATE</div><div id="fs-flow-induct" style="font-size:20px;font-weight:700;color:#60a5fa;font-family:monospace;">\u2014</div></div>';
    html+='<div style="flex:0;font-size:20px;color:#475569;">vs</div>';
    html+='<div style="flex:1;text-align:center;"><div style="font-size:10px;color:#64748b;">SORT RATE</div><div id="fs-flow-sort" style="font-size:20px;font-weight:700;color:#a78bfa;font-family:monospace;">\u2014</div></div>';
    html+='<div style="flex:1;text-align:center;"><div style="font-size:10px;color:#64748b;">\u00c9CART</div><div id="fs-flow-gap" style="font-size:20px;font-weight:700;font-family:monospace;">\u2014</div></div>';
    html+='</div>';
    html+='<div id="fs-flow-alert" style="margin-top:10px;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:500;display:none;"></div>';
    html+='</div>';

    html+='<div style="background:#1e293b;border-radius:10px;border:1px solid #334155;padding:16px;margin-bottom:16px;">';
    html+='<div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:10px;">D\u00e9tail par tranche horaire</div>';
    html+='<div style="overflow-x:auto;max-height:300px;overflow-y:auto;"><table id="fs-table" style="width:100%;border-collapse:collapse;font-size:12px;font-family:monospace;"><thead><tr style="color:#64748b;border-bottom:2px solid #475569;"><th style="padding:6px;text-align:left;">Tranche</th><th>Actual</th><th>Target</th><th>Cumul\u00e9</th><th>Tgt Cumul\u00e9</th><th>Avance/Retard</th><th>Shift</th></tr></thead><tbody id="fs-tbody"></tbody></table></div>';
    html+='</div>';

    html+='<div style="text-align:center;font-size:11px;color:#475569;padding:10px 0;">Station: <b>'+state.station+'</b> | <span id="fs-countdown">Refresh: 60s</span> | <span id="fs-lastupd">\u2014</span> <span id="fs-ref" style="cursor:pointer;padding:3px 10px;background:#374151;border-radius:4px;margin-left:6px;">\uD83D\uDD04 Rafra\u00eechir</span></div>';

    html+='</div>';

    fs.innerHTML=html;
    document.body.appendChild(fs);

    document.getElementById('fs-close').onclick=closeFullScreen;
    document.getElementById('fs-ref').onclick=fetchData;
    bindConfigInputs('fs');
    setInterval(function(){var e=document.getElementById('fs-clock');if(e)e.textContent=new Date().toLocaleTimeString('fr-FR');},1000);
}

function buildChart(r){
    var chartDiv=document.getElementById('fs-chart');
    if(!chartDiv)return;
    var n=now();
    var fH=state.finHS;
    var nsEffT=effTime(0,NS_END),hsEffT=effTime(HS_START,fH);
    var rN=nsEffT>0.01?state.volNS/nsEffT:0, rH=hsEffT>0.01?state.volHS/hsEffT:0;
    var hours=['00-01','01-02','02-03','03-04','04-05','05-06','06-07','07-08','08-09','09-10'];
    var targets=[],actuals=[];
    var tgt=0;
    for(var i=0;i<10;i++){
        var hStart=i,hEnd=i+1;
        var effH=effTime(hStart,hEnd);
        if(hEnd<=NS_END)tgt+=rN*effH;
        else if(hStart>=HS_START)tgt+=rH*effH;
        else{tgt+=rN*effTime(hStart,NS_END)+rH*effTime(HS_START,Math.min(hEnd,fH));}
        targets.push(Math.round(tgt));
        if(hEnd<=n){
            actuals.push(Math.round(state.totalInducted*(effTime(0,hEnd)/Math.max(0.01,effTime(0,Math.min(n,fH))))));
        } else if(hStart<n){
            actuals.push(state.totalInducted);
        } else {
            actuals.push(0);
        }
    }
    var maxVal=Math.max.apply(null,targets.concat(actuals))||1;

    var svgW=chartDiv.clientWidth||800,svgH=180;
    var barW=Math.floor((svgW-60)/10)-8;
    var svg='<svg width="'+svgW+'" height="'+svgH+'" style="display:block;">';
    for(var i=0;i<10;i++){
        var x=40+i*(barW+8);
        var tH=Math.round((targets[i]/maxVal)*(svgH-30));
        var aH=Math.round((actuals[i]/maxVal)*(svgH-30));
        svg+='<rect x="'+x+'" y="'+(svgH-25-tH)+'" width="'+barW+'" height="'+tH+'" fill="#1e293b" stroke="#475569" stroke-width="1" rx="3"/>';
        var col=actuals[i]>=targets[i]?'#34d399':'#f87171';
        if(actuals[i]===0)col='#334155';
        svg+='<rect x="'+x+'" y="'+(svgH-25-aH)+'" width="'+barW+'" height="'+Math.max(aH,0)+'" fill="'+col+'" rx="3" opacity="0.85"/>';
        svg+='<text x="'+(x+barW/2)+'" y="'+(svgH-8)+'" text-anchor="middle" fill="#64748b" font-size="9">'+hours[i]+'</text>';
    }
    svg+='<rect x="'+40+'" y="4" width="10" height="10" fill="#334155" stroke="#475569"/><text x="55" y="13" fill="#64748b" font-size="9">Target</text>';
    svg+='<rect x="'+110+'" y="4" width="10" height="10" fill="#34d399"/><text x="125" y="13" fill="#64748b" font-size="9">R\u00e9el (OK)</text>';
    svg+='<rect x="'+195+'" y="4" width="10" height="10" fill="#f87171"/><text x="210" y="13" fill="#64748b" font-size="9">R\u00e9el (retard)</text>';
    svg+='</svg>';
    chartDiv.innerHTML=svg;
}

function buildTable(r){
    var wipEl = document.getElementById('fs-wip-value');
    var wipBar = document.getElementById('fs-wip-bar');
    var wipAlert = document.getElementById('fs-wip-alert');
    var wipGraph = document.getElementById('fs-wip-graph');

    if(wipEl){
        var wip = state.stowWIP || 0;
        var wipColor = '#94a3b8';
        if(wip > 0){
            if(wip < 10) wipColor = '#f59e0b';
            else if(wip <= 19) wipColor = '#22c55e';
            else wipColor = '#ef4444';
        }
        wipEl.textContent = wip > 0 ? wip.toFixed(1) + ' min' : '\u2014';
        wipEl.style.color = wipColor;

        if(wipBar){
            var pct = Math.min(100, (wip / 30) * 100);
            wipBar.style.width = pct + '%';
            wipBar.style.background = wipColor;
        }

        if(wipAlert && wip > 0){
            var r = calc();
            var isOnTarget = r.delta >= 0;
            var msg = '', bgCol = '', txtCol = '';

            if(wip > 19){
                if(isOnTarget){
                    msg = '\u26A0\uFE0F WIP \u00e9lev\u00e9 \u2014 Ralentir l\'induction, le stow ne suit pas';
                    bgCol = '#7f1d1d'; txtCol = '#fca5a5';
                } else {
                    msg = '\uD83D\uDD34 WIP \u00e9lev\u00e9 + Retard \u2014 Renforcer le stow imm\u00e9diatement';
                    bgCol = '#7f1d1d'; txtCol = '#fca5a5';
                }
            } else if(wip < 10){
                if(isOnTarget){
                    msg = '\uD83D\uDFE1 WIP bas \u2014 Ralentir le stow ou ouvrir une table suppl\u00e9mentaire';
                    bgCol = '#78350f'; txtCol = '#fde68a';
                } else {
                    msg = '\uD83D\uDEA8 WIP bas + Retard \u2014 Ouvrir absolument une table suppl\u00e9mentaire !';
                    bgCol = '#7f1d1d'; txtCol = '#fca5a5';
                }
            } else {
                if(isOnTarget){
                    msg = '\u2705 WIP normal, on est dans les temps';
                    bgCol = '#052e16'; txtCol = '#86efac';
                } else {
                    msg = '\u26A1 WIP OK mais en retard \u2014 Maintenir le rythme';
                    bgCol = '#1e293b'; txtCol = '#fde68a';
                }
            }

            wipAlert.style.display = 'block';
            wipAlert.style.background = bgCol;
            wipAlert.style.color = txtCol;
            wipAlert.textContent = msg;
        }

        if(wipGraph && state.stowWIPHistory.length > 0){
            var bars = '';
            var maxW = 30;
            state.stowWIPHistory.slice(-30).forEach(function(h){
                var hPct = Math.min(100, (h.wip / maxW) * 100);
                var bColor = h.wip < 10 ? '#f59e0b' : (h.wip <= 19 ? '#22c55e' : '#ef4444');
                bars += '<div style="flex:1;min-width:3px;height:'+hPct+'%;background:'+bColor+';border-radius:2px 2px 0 0;" title="'+h.time+': '+h.wip.toFixed(1)+'min"></div>';
            });
            wipGraph.innerHTML = bars;
        }
    }

    var flowInductEl = document.getElementById('fs-flow-induct');
    var flowSortEl = document.getElementById('fs-flow-sort');
    var flowGapEl = document.getElementById('fs-flow-gap');
    var flowAlertEl = document.getElementById('fs-flow-alert');

    if(flowInductEl && state.inductRate > 0){
        var iRate = state.inductRate;
        var sRate = state.stowRate || 0;
        flowInductEl.textContent = iRate.toLocaleString() + '/h';
        flowSortEl.textContent = sRate > 0 ? sRate.toLocaleString() + '/h' : '\u2014';

        if(sRate > 0){
            var maxRate = Math.max(iRate, sRate);
            var ecart = Math.abs(iRate - sRate) / maxRate * 100;
            flowGapEl.textContent = ecart.toFixed(1) + '%';

            if(ecart <= 5){
                flowGapEl.style.color = '#34d399';
                flowAlertEl.style.display = 'none';
            } else {
                flowGapEl.style.color = '#f87171';
                flowAlertEl.style.display = 'block';
                if(iRate > sRate){
                    flowAlertEl.style.background = '#7f1d1d';
                    flowAlertEl.style.color = '#fca5a5';
                    flowAlertEl.textContent = '\u26A0\uFE0F D\u00e9s\u00e9quilibre : Induction (+'+ecart.toFixed(0)+'%) d\u00e9passe le Sort \u2014 Risque accumulation WIP';
                } else {
                    flowAlertEl.style.background = '#78350f';
                    flowAlertEl.style.color = '#fde68a';
                    flowAlertEl.textContent = '\u26A0\uFE0F D\u00e9s\u00e9quilibre : Sort (+'+ecart.toFixed(0)+'%) d\u00e9passe l\'Induction \u2014 Ralentir ou alimenter';
                }
            }
        }
    }

    var tbody=document.getElementById('fs-tbody');
    if(!tbody)return;
    var fH=state.finHS;
    var n=now();
    var hsEffTotal = fH - (5+37/60);
    var rN=state.volNS/4.8, rH=hsEffTotal>0.01?state.volHS/hsEffTotal:0;

    var TRANCHES = [
        {label:'00:10 \u2013 01:00', start:10/60, end:1,      dur:50, shift:'NS'},
        {label:'01:00 \u2013 02:00', start:1,     end:2,      dur:60, shift:'NS'},
        {label:'02:00 \u2013 03:00', start:2,     end:3,      dur:60, shift:'NS'},
        {label:'03:00 \u2013 03:30', start:3,     end:3.5,    dur:30, shift:'NS'},
        {label:'03:30 \u2013 03:55', start:3.5,   end:3+55/60,dur:25, shift:'\u23F8 Pause'},
        {label:'03:55 \u2013 05:00', start:3+55/60,end:5,     dur:65, shift:'NS'},
        {label:'05:00 \u2013 05:22', start:5,     end:5+22/60,dur:22, shift:'NS'},
        {label:'05:22 \u2013 05:37', start:5+22/60,end:5+37/60,dur:15,shift:'\u23F8 Pause'}
    ];
    var hsStart=5+37/60;
    TRANCHES.push({label:'05:37 \u2013 06:00', start:hsStart, end:6, dur:23, shift:'HS'});
    var hsH=6;
    while(hsH < Math.floor(fH)){
        TRANCHES.push({label:String(hsH).padStart(2,'0')+':00 \u2013 '+String(hsH+1).padStart(2,'0')+':00', start:hsH, end:hsH+1, dur:60, shift:'HS'});
        hsH++;
    }
    if(fH > Math.floor(fH)){
        var lastMin=Math.round((fH-Math.floor(fH))*60);
        TRANCHES.push({label:String(Math.floor(fH)).padStart(2,'0')+':00 \u2013 '+hhmm(fH), start:Math.floor(fH), end:fH, dur:lastMin, shift:'HS'});
    }

    var rows='';
    var cumulTarget=0;

    var snapKeys = Object.keys(state.snapshots).sort();

    for(var i=0;i<TRANCHES.length;i++){
        var tr=TRANCHES[i];
        var isPause = tr.shift.indexOf('Pause')>=0;
        var rate = isPause ? 0 : (tr.shift==='NS' ? rN : rH);
        var targetSlot = Math.round(rate * tr.dur / 60);
        cumulTarget += targetSlot;

        var actualSlot = '\u2014';
        var cumulActual = '\u2014';

        var startSnap = null, endSnap = null;
        for(var s=0;s<snapKeys.length;s++){
            var parts=snapKeys[s].split(':');
            var sTime=parseInt(parts[0])+parseInt(parts[1])/60;
            if(sTime <= tr.start) startSnap = state.snapshots[snapKeys[s]];
            if(sTime <= tr.end) endSnap = state.snapshots[snapKeys[s]];
        }

        if(tr.end <= n && endSnap !== null){
            actualSlot = endSnap - (startSnap||0);
            cumulActual = endSnap;
        } else if(tr.start < n && tr.end > n){
            cumulActual = state.totalInducted;
            if(startSnap !== null) actualSlot = state.totalInducted - startSnap;
            else actualSlot = state.totalInducted;
        }

        var delta = '';
        var dCol = '#94a3b8';
        if(typeof cumulActual === 'number' && cumulActual > 0){
            var d = cumulActual - cumulTarget;
            delta = (d>=0?'+':'')+d.toLocaleString();
            dCol = d>=0?'#34d399':'#f87171';
        }

        var trColor = isPause ? 'opacity:0.4;background:#1a1520;' : (tr.end<=n?'':'opacity:0.7;');

        rows+='<tr style="border-bottom:1px solid #1e293b;'+trColor+'">';
        rows+='<td style="padding:6px 8px;color:#94a3b8;font-weight:500;">'+tr.label+'</td>';
        rows+='<td style="text-align:center;font-weight:600;">'+(typeof actualSlot==='number'?actualSlot.toLocaleString():'\u2014')+'</td>';
        rows+='<td style="text-align:center;color:#94a3b8;">'+(isPause?'\u2014':targetSlot.toLocaleString())+'</td>';
        rows+='<td style="text-align:center;font-weight:600;color:#60a5fa;">'+(typeof cumulActual==='number'?cumulActual.toLocaleString():'\u2014')+'</td>';
        rows+='<td style="text-align:center;color:#94a3b8;">'+(isPause?'\u2014':cumulTarget.toLocaleString())+'</td>';
        rows+='<td style="text-align:center;color:'+dCol+';font-weight:600;">'+delta+'</td>';
        rows+='<td style="text-align:center;font-size:10px;color:#475569;">'+tr.shift+'</td>';
        rows+='</tr>';
    }
    tbody.innerHTML=rows;
}

function updateFullScreen(){
    if(!state.fullScreen)return;
    var r=calc();
    var el=function(id){return document.getElementById(id);};
    if(!el('fs-cum'))return;

    el('fs-cum').textContent=r.c.toLocaleString();
    el('fs-rem').textContent=r.rem.toLocaleString();
    el('fs-pct').textContent=r.pct+'%';
    el('fs-eta').textContent=r.eta;
    el('fs-eta').style.color=r.etaOk?'#34d399':'#f87171';
    el('fs-held').textContent=state.held.toLocaleString();
    el('fs-rate').textContent=r.liveRate.toLocaleString()+'/h';

    var bar=el('fs-delta');
    if(r.c>0){
        if(r.delta>0){bar.style.cssText='padding:14px;border-radius:10px;text-align:center;font-size:22px;font-weight:700;font-family:monospace;margin-bottom:16px;background:#052e16;color:#34d399;border:1px solid #166534;';bar.textContent='\u25B2 EN AVANCE : +'+r.delta.toLocaleString()+' colis';}
        else if(r.delta<0){bar.style.cssText='padding:14px;border-radius:10px;text-align:center;font-size:22px;font-weight:700;font-family:monospace;margin-bottom:16px;background:#2d0a0a;color:#f87171;border:1px solid #7f1d1d;';bar.textContent='\u25BC EN RETARD : '+r.delta.toLocaleString()+' colis';}
        else{bar.style.cssText='padding:14px;border-radius:10px;text-align:center;font-size:22px;font-weight:700;font-family:monospace;margin-bottom:16px;background:#1e293b;color:#94a3b8;border:1px solid #334155;';bar.textContent='= DANS LES TEMPS';}
    }

    el('fs-nsa').textContent=r.nsI>0?r.nsI.toLocaleString():'\u2014';
    el('fs-nsn').textContent=r.nsRN>0?r.nsRN.toLocaleString()+'/h':'\u2014';
    el('fs-nsn').style.color=r.nsRN<=r.rN?'#34d399':'#f87171';
    el('fs-nst').textContent=fmt(r.nsTL);

    el('fs-hsa').textContent=r.hsI>0?r.hsI.toLocaleString():'\u2014';
    el('fs-hsn').textContent=r.hsRN>0?r.hsRN.toLocaleString()+'/h':'\u2014';
    el('fs-hsn').style.color=r.hsRN<=r.rH?'#34d399':'#f87171';
    el('fs-hst').textContent=fmt(r.hsTL);

    var lu=el('fs-lastupd');if(lu)lu.textContent='MAJ: '+new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

    buildChart(r);
    buildTable(r);
}

// ======== INIT ========
function start(){
    if(!document.body){setTimeout(start,500);return;}
    if(document.getElementById('it3-btn'))return;
    interceptKey();
    state.station=detectStation();
    createButton();
}

start();
setTimeout(start,2000);
setTimeout(start,5000);

})();
