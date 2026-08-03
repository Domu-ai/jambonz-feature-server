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
