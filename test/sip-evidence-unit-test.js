const test = require('tape');
const {CallStatus} = require('../lib/utils/constants');
const {SingleDialer} = require('../lib/utils/place-outdial');

const noop = () => {};

function makeDialer() {
  return new SingleDialer({
    logger: {bindings: () => ({}), debug: noop, info: noop, error: noop},
    target: {type: 'phone'},
    opts: {},
    application: {},
    callInfo: {},
    accountInfo: {},
    rootSpan: {},
    startSpan: noop
  });
}

function makeExecHarness({responseReason = 'OK', modifyError} = {}) {
  const events = [];
  const dialer = makeDialer();
  dialer.removeAllListeners('callStatusChange');
  dialer.on('callStatusChange', (status) => events.push(status));
  dialer.target.number = '+15551234567';
  dialer.callInfo = {};
  dialer.startSpan = () => ({setAttributes: noop, end: noop});
  dialer._createMediaEndpoint = async() => ({
    uuid: 'endpoint-1',
    local: {sdp: 'local-sdp'},
    modify: async() => {
      if (modifyError) throw modifyError;
    },
    destroy: async() => {}
  });

  const dialog = {
    remote: {sdp: 'remote-sdp'},
    res: {
      reason: responseReason,
      has: () => false,
      get: () => undefined
    },
    on: function() { return this; }
  };
  const srf = {
    locals: {
      dbHelpers: {updateCallStatus: async() => {}},
      serviceUrl: 'https://example.test',
      fsUUID: undefined
    },
    createUAC: async() => dialog
  };

  return {dialer, events, srf};
}

test('SIP response evidence headers are allowlisted', (t) => {
  const values = {
    reason: 'Q.850;cause=31',
    'x-khomp-analytics-cc': 'Voice mail',
    authorization: 'secret',
    'x-customer-data': 'private'
  };
  const message = {
    has: (name) => values[name.toLowerCase()] !== undefined,
    get: (name) => values[name.toLowerCase()]
  };

  t.deepEqual(makeDialer()._extractSipEvidenceHeaders(message), {
    Reason: 'Q.850;cause=31',
    'X-Khomp-Analytics-CC': 'Voice mail'
  });
  t.end();
});

test('BYE custom-header forwarding remains backwards compatible', (t) => {
  const headers = {
    via: 'internal',
    reason: 'Q.850;cause=16',
    'x-existing-integration': 'preserved'
  };

  t.deepEqual(makeDialer()._extractCustomHeaders({headers}), {
    reason: 'Q.850;cause=16',
    'x-existing-integration': 'preserved'
  });
  t.end();
});

test('status callbacks do not reuse SIP evidence from a previous message', (t) => {
  const payloads = [];
  const dialer = makeDialer();
  dialer.application = {
    call_status_hook: 'https://example.test/status',
    notifier: {request: (_type, _url, payload) => payloads.push(payload)}
  };
  dialer.callInfo = {
    updateCallStatus: noop,
    toJSON() {
      return {
        ...(this.sipHeaders && {headers: this.sipHeaders}),
        ...(this.sipEvidence && {sipEvidence: this.sipEvidence})
      };
    }
  };
  dialer.updateCallStatus = async() => {};

  dialer._notifyCallStatusChange({
    callStatus: CallStatus.InProgress,
    sipStatus: 200,
    sipReason: 'OK',
    headers: {Reason: 'Q.850;cause=16'},
    sipEvidence: {messageKind: 'response', responseCode: 200}
  });
  dialer._notifyCallStatusChange({
    callStatus: CallStatus.Ringing,
    sipStatus: 180,
    sipReason: 'Ringing'
  });

  t.ok(payloads[0].headers);
  t.ok(payloads[0].sipEvidence);
  t.notOk(payloads[1].headers);
  t.notOk(payloads[1].sipEvidence);
  t.end();
});

test('observed 200 evidence preserves the provider reason phrase', async(t) => {
  const {dialer, events, srf} = makeExecHarness({responseReason: 'Call Accepted'});

  await dialer.exec(srf, {}, {});

  const connected = events.find(({callStatus}) => callStatus === CallStatus.InProgress);
  t.equal(connected.sipStatus, 200);
  t.equal(connected.sipReason, 'Call Accepted');
  t.equal(connected.sipEvidence.responseCode, 200);
  t.equal(connected.sipEvidence.responseText, 'Call Accepted');
  t.equal(connected.sipEvidence.evidenceQuality, 'observed');
  t.end();
});

test('post-answer media failures do not invent an observed SIP 500', async(t) => {
  const {dialer, events, srf} = makeExecHarness({
    modifyError: new Error('media attachment failed')
  });

  await dialer.exec(srf, {}, {});

  const failed = events.find(({callStatus}) => callStatus === CallStatus.Failed);
  t.equal(failed.sipStatus, 500);
  t.equal(failed.sipEvidence.messageKind, 'synthetic_status');
  t.equal(failed.sipEvidence.evidenceQuality, 'inferred');
  t.notOk(failed.sipEvidence.responseCode);
  t.end();
});
