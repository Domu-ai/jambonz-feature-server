const assert = require('assert');
const Task = require('./task');
const {SingleDialer} = require('../utils/place-outdial');
const {TaskName, TaskPreconditions, MediaPath} = require('../utils/constants');
const sessionTracker = require('../session/session-tracker');
const crypto = require('crypto');
const snakeCaseKeys = require('../utils/snakecase-keys');

const RING_MS = 12000;
const CLEANUP_MS = 2000;
const BACKOFF_MS = 1000;

/** Each original dialog remains owned by a native CallSession, including after recovery. */
class TransferLeg extends Task {
  constructor(logger, operation, role) {
    super(logger, {});
    this.operation = operation;
    this.role = role;
    operation.legs[role] = this;
    this.preconditions = TaskPreconditions.Endpoint;
  }
  get name() { return 'sip:transfer'; }
  async exec(cs) {
    await super.exec(cs);
    this.operation.attach(this.role, this);
    await this.awaitTaskDone();
  }
  kill(cs) {
    if (this.killed) return;
    super.kill(cs);
    this.operation.ended(this.role);
    this.notifyTaskDone();
  }
}

class SipTransfer {
  constructor(cs, data) {
    this.controller = cs;
    this.data = data;
    this.deadline = Math.min(Date.parse(data.deadline), Date.now() + 30000);
    this.legs = {};
    this.attempts = [];
    this.timer = setTimeout(() => {
      this.expired = true;
      this.stopDestination().catch((err) => cs.logger.info(err, 'Transfer deadline cleanup failed'));
      if (!this.running) this.finish(this.prepared ? 'returned-to-bot' : 'unknown');
    }, Math.max(0, this.deadline - Date.now() - CLEANUP_MS));
  }

  attach(role, task) {
    this.legs[role] = task;
    if (this.cancelled) {
      task.notifyTaskDone();
      return;
    }
    if (this.legs.caller?.cs && this.legs.agent?.cs && !this.running && !this.outcome) {
      this.running = true;
      this.run().catch(async(err) => {
        this.controller.logger.error({err}, 'Preserved SIP transfer failed');
        this.ended('caller');
        await this.finish('unknown');
      });
    }
  }

  alive() {
    return !this.cancelled && this.legs.caller?.cs?.dlg?.connected &&
      this.legs.agent?.cs?.dlg?.connected;
  }

  ended(role) {
    if (role === 'agent' && this.connected) return;
    this.cancelled = true;
    this.stopDestination().catch((err) => this.controller.logger.info(err, 'Transfer destination cleanup failed'));
    for (const [otherRole, task] of Object.entries(this.legs)) {
      if (otherRole !== role && !task.killed) {
        task.notifyTaskDone();
        const owner = task.cs || task.owner;
        if (owner?.dlg?.connected) {
          owner._lccCallStatus({call_status: 'completed'});
        }
      }
    }
  }

  async report(outcome) {
    const payload = JSON.stringify(snakeCaseKeys({
      ...this.controller.callInfo.toJSON(),
      transferId: this.data.transferId,
      transferOutcome: outcome,
      transferAttempts: this.attempts
    }));
    for (let n = 0; n < 3; n++) {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = crypto.createHmac('sha256', this.controller.accountInfo.account.webhook_secret)
          .update(`${timestamp}.${payload}`).digest('hex');
        const response = await global.fetch(this.data.actionHook, {
          method: 'POST', body: payload, redirect: 'error', signal: global.AbortSignal.timeout(1000),
          headers: {'Content-Type': 'application/json', 'Jambonz-Signature': `t=${timestamp},v1=${signature}`}
        });
        if (response.ok) return await response.json();
        if (response.status < 500) return {accepted: false};
      } catch (err) {
        if (n === 2) throw err;
      }
    }
    throw new Error('Transfer result endpoint unavailable');
  }

  async finish(outcome) {
    if (this.outcome) return;
    this.outcome = outcome;
    clearTimeout(this.timer);
    try {
      await this.report(outcome);
    } catch (err) {
      this.controller.logger.error({err, transferId: this.data.transferId}, 'Transfer result delivery failed');
    }
  }

  async stopHold() {
    if (!this.hold) return;
    const caller = this.legs.caller.cs;
    await caller.ep.api('uuid_break', caller.ep.uuid);
    await this.hold;
    this.hold = undefined;
  }

  stopDestination() {
    if (!this.destination) return Promise.resolve();
    if (!this.cleanup) this.cleanup = this.destination.kill();
    return this.cleanup;
  }

  async waitForCleanup() {
    let timer;
    try {
      return await Promise.race([
        this.stopDestination().then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, Math.min(CLEANUP_MS, this.deadline - Date.now())));
        })
      ]);
    } catch (err) {
      this.controller.logger.error({err}, 'Transfer destination teardown is unconfirmed');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async attempt() {
    const caller = this.legs.caller.cs;
    const attempt = {attemptId: `${this.data.transferId}:${this.attempts.length + 1}`};
    const sd = this.destination = new SingleDialer({
      logger: caller.logger, sbcAddress: caller.srf.locals.getSBC(), target: this.data.target,
      opts: {}, application: caller.application, callInfo: caller.callInfo,
      accountInfo: caller.accountInfo, rootSpan: caller.rootSpan,
      startSpan: this.legs.caller.startSpan.bind(this.legs.caller),
      dialTask: {cs: caller, kill: () => { if (!sd.killed) this.ended('caller'); }},
      tmpFiles: caller.tmpFiles
    });
    this.cleanup = undefined;
    attempt.callSid = sd.callSid;
    this.attempts.push(attempt);
    // No INVITE is sent until Kiban durably admits this exact attempt.
    const admission = await this.report('attempting');
    if (!admission?.accepted || !this.alive() || this.expired ||
      this.deadline - Date.now() < RING_MS + CLEANUP_MS) return;
    if (!this.hold) {
      await caller.ep.unbridge();
      this.unbridged = true;
      this.hold = caller.ep.play('tone_stream://%(1000,1000,350,440);loops=30').catch(() => {});
    }
    if (!this.alive() || this.expired || this.deadline - Date.now() < RING_MS + CLEANUP_MS) return;
    let accepted = false;
    sd.on('callStatusChange', (status) => {
      attempt.status = status.callStatus;
      if (status.sipStatus !== undefined) attempt.sipStatus = status.sipStatus;
    });
    sd.once('accept', () => { accepted = true; });
    const ringTimer = setTimeout(() => {
      this.stopDestination().catch((err) => caller.logger.info(err, 'Transfer ring timeout cleanup failed'));
    }, RING_MS);
    const execution = sd.exec(caller.srf, caller.getMS(), {
      callingNumber: this.data.callerId,
      headers: {'X-Account-Sid': caller.accountSid, ...this.data.headers}
    });
    let cleanupTimer;
    const settled = await Promise.race([
      execution.then(() => true),
      new Promise((resolve) => { cleanupTimer = setTimeout(() => resolve(false), RING_MS + CLEANUP_MS); })
    ]);
    clearTimeout(ringTimer);
    clearTimeout(cleanupTimer);
    if (accepted && !sd.killed && this.alive() && Date.now() < this.deadline) return sd;
    const cleaned = await this.waitForCleanup();
    attempt.teardownConfirmed = settled && cleaned && !sd.dlg?.connected && !sd.ep?.connected;
    return undefined;
  }

  async run() {
    const caller = this.legs.caller.cs;
    const agent = this.legs.agent.cs;
    try {
      // Preparation preserved the original bridge. Re-bridging it here races
      // FreeSWITCH's existing bridge task with the subsequent unbridge.
      for (let n = 0; n < 2 && this.alive() && !this.expired; n++) {
        if (this.deadline - Date.now() < RING_MS + CLEANUP_MS) break;
        const destination = await this.attempt();
        if (destination) {
          await this.stopHold();
          await caller.ep.bridge(destination.ep);
          // Recheck after the media operation; a crossed timeout must never release the bot.
          if (!this.alive() || this.expired || !destination.dlg.connected) break;
          this.connected = true;
          destination.dlg.once('destroy', () => this.legs.caller.notifyTaskDone());
          this.legs.agent.notifyTaskDone();
          await this.finish('connected');
          return;
        }
        const last = this.attempts[this.attempts.length - 1];
        if (n !== 0 || last?.sipStatus !== 503 || !last.teardownConfirmed ||
          this.deadline - Date.now() < BACKOFF_MS + RING_MS + CLEANUP_MS) break;
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
      }
    } catch (err) {
      caller.logger.error({err}, 'Transfer attempt failed; restoring original conversation');
    }
    await this.waitForCleanup();
    if (!this.alive()) {
      this.ended('caller');
      await this.finish('caller-ended');
      return;
    }
    if (this.unbridged) {
      await this.stopHold();
      await caller.ep.bridge(agent.ep);
    }
    await this.finish('returned-to-bot');
  }
}

/** Called only by the authenticated live-control hook, before replacing the original Dial. */
async function startSipTransfer(cs, data) {
  assert(typeof data.transferId === 'string' && data.transferId.length > 0, 'Missing transfer identity');
  if (cs.sipTransfer) {
    assert(cs.sipTransfer.data.transferId === data.transferId, 'Another transfer owns this call');
    return;
  }
  assert(['inbound', 'outbound'].includes(data.direction), 'Invalid transfer direction');
  assert(data.target?.type === 'sip' && /^sips?:[^\r\n]+$/.test(data.target.sipUri), 'Invalid SIP target');
  assert(Number.isFinite(Date.parse(data.deadline)), 'Missing transfer deadline');
  assert(/^https?:\/\//.test(data.actionHook), 'Missing transfer result hook');
  const dial = cs.currentTask;
  assert(dial?.name === TaskName.Dial && dial.sd?.dlg?.connected && cs.dlg?.connected, 'No connected Dial to transfer');
  const operation = cs.sipTransfer = new SipTransfer(cs, data);
  const child = dial.sd;
  try {
    // Retain each previous SDP until both re-INVITEs and the bridge succeed.
    // A rejection on one leg must not leave the other sending media to FreeSWITCH.
    const originals = [cs, child].map((leg) => ({leg, ep: leg.ep, sdp: leg.dlg.local.sdp, moved: false}));
    const anchored = await Promise.allSettled(originals.map(async(original) => {
      const {leg, ep} = original;
      if (ep) return;
      leg.ep = await leg._createMediaEndpoint({remoteSdp: leg.dlg.remote.sdp});
      if (cs.callGone || child.killed || !leg.dlg?.connected) {
        await leg.ep.destroy();
        leg.ep = null;
        throw new Error('Call ended during media allocation');
      }
      await leg.dlg.modify(leg.ep.local.sdp, {headers: {'X-Reason': 'anchor-media'}});
      original.moved = true;
      if (dial._mediaPath === MediaPath.NoMedia) await leg.ep.modify(leg.dlg.remote.sdp);
    }));
    try {
      const failed = anchored.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (originals.some(({ep}) => !ep)) await cs.ep.bridge(child.ep);
    } catch (err) {
      await Promise.all(originals.map(async({leg, ep, sdp, moved}) => {
        if (!ep && leg.ep) {
          // A rejected re-INVITE did not move its peer. Only compensate the
          // accepted leg, and restore the rejected dialog's local SDP cache.
          if (moved) await leg.dlg.modify(sdp);
          else leg.dlg.local.sdp = sdp;
          await leg.ep.destroy();
          leg.ep = null;
        }
      }));
      throw err;
    }
    dial.epOther = cs.ep;
    dial._mediaPath = MediaPath.FullMedia;
    operation.prepared = true;
    if (cs.callGone || child.killed || Date.now() >= operation.deadline) throw new Error('Call ended before transfer');
    const childRole = data.direction === 'inbound' ? 'agent' : 'caller';
    const parentRole = data.direction === 'inbound' ? 'caller' : 'agent';
    const childTask = new TransferLeg(cs.logger, operation, childRole);
    const parentTask = new TransferLeg(cs.logger, operation, parentRole);
    const childSession = await child.doAdulting({logger: cs.logger, application: cs.application,
      tasks: [childTask], preserveMedia: true});
    childTask.owner = childSession;
    sessionTracker.add(childSession.callSid, childSession);
    if (cs.callGone) {
      operation.ended(parentRole);
      await operation.finish('caller-ended');
      return;
    }
    cs.replaceApplication([parentTask]);
  } catch (err) {
    cs.logger.error({err}, 'Unable to prepare preserved transfer');
    await operation.finish(cs.callGone || child.killed ? 'caller-ended' : 'unknown');
  }
}

module.exports = {startSipTransfer};
