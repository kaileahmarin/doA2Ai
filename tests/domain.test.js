import assert from "node:assert/strict";
import test from "node:test";

import {
  RESEARCH_PACKET,
  ResearchBriefEngine,
  canonicalize,
  compareStates,
  createAgentToolDefinitions,
  sha256,
} from "../app/domain.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

function makeHarness({ origin = "https://research.example.test", executor, executionTimeoutMs } = {}) {
  let now = new Date("2026-08-27T16:00:00.000Z");
  let sequence = 0;
  const engine = new ResearchBriefEngine({
    origin,
    clock: () => new Date(now),
    idFactory: (prefix) => `${prefix}_${++sequence}`,
    ...(executor ? { executor } : {}),
    ...(executionTimeoutMs ? { executionTimeoutMs } : {}),
  });
  return {
    engine,
    advance(milliseconds) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

function errorWithCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function toolNames(engine) {
  return createAgentToolDefinitions(engine).map(({ name }) => name);
}

function findTool(engine, name) {
  const tool = createAgentToolDefinitions(engine).find((definition) => definition.name === name);
  assert.ok(tool, `Expected ${name} to be exposed`);
  return tool;
}

async function prepare(engine) {
  const handles = engine.handles();
  engine.readResearchSources(handles);
  const { brief_draft: briefDraft } = engine.composeResearchBrief({
    ...handles,
    citation_style: RESEARCH_PACKET.required_citation_style,
  });
  engine.prepareBriefShare({ ...handles, draft_id: briefDraft.draft_id });
  return { handles, briefDraft };
}

async function authorize(engine) {
  return engine.grantAuthorization({
    sharing_confirmation: true,
    collaborator_note_id: "note_fixture_3812",
  });
}

function assertAgentSafe(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.doesNotMatch(serialized, /human_only|sharing_confirmation|collaborator_note/i);
}

test("canonical JSON and SHA-256 are deterministic across object insertion order", async () => {
  const first = { z: null, b: [3, { c: 4 }], a: { y: 2, x: 1 } };
  const second = { a: { x: 1, y: 2 }, b: [3, { c: 4 }], z: null };
  const expected = '{"a":{"x":1,"y":2},"b":[3,{"c":4}],"z":null}';

  assert.equal(canonicalize(first), expected);
  assert.equal(canonicalize(second), expected);
  assert.equal(await sha256(first), await sha256(second));
  assert.equal(await sha256({ b: 2, a: 1 }), "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
});

test("state comparison reports field-level differences and distinguishes missing fields", () => {
  assert.deepEqual(
    compareStates(
      { brief: { word_count: 900, citation_style: "linked_endnotes" }, draft_version: 1 },
      { brief: { word_count: 1200, citation_style: "linked_endnotes" }, draft_version: 2 },
    ).differences,
    [
      { field: "brief.word_count", authorized: 900, candidate: 1200 },
      { field: "draft_version", authorized: 1, candidate: 2 },
    ],
  );
  assert.deepEqual(compareStates({}, { note: null }).differences, [
    { field: "note", authorized: null, candidate: null, authorized_present: false, candidate_present: true },
  ]);
});

test("the research-brief preparation flow is ordered, handle-bound, and source-scoped", () => {
  const { engine } = makeHarness();
  const handles = engine.handles();

  assert.deepEqual(toolNames(engine), ["read_research_sources", "read_task_status"]);
  assert.throws(
    () => engine.composeResearchBrief({ ...handles, citation_style: RESEARCH_PACKET.required_citation_style }),
    errorWithCode("STEP_INVALID"),
  );
  assert.throws(
    () => engine.readResearchSources({ ...handles, task_id: "task_elsewhere" }),
    errorWithCode("TASK_MISMATCH"),
  );

  const sourceRead = engine.readResearchSources(handles);
  assert.equal(sourceRead.research_packet.topic, RESEARCH_PACKET.topic);
  assert.deepEqual(sourceRead.research_packet.required_source_ids, RESEARCH_PACKET.required_source_ids);
  assert.deepEqual(toolNames(engine), ["compose_research_brief", "read_task_status"]);
  assert.throws(
    () => engine.composeResearchBrief({ ...handles, citation_style: "footnotes" }),
    errorWithCode("CONSTRAINT_MISMATCH"),
  );

  const { brief_draft: briefDraft } = engine.composeResearchBrief({
    ...handles,
    citation_style: RESEARCH_PACKET.required_citation_style,
  });
  assert.equal(briefDraft.source_count, RESEARCH_PACKET.required_source_ids.length);
  assert.deepEqual(toolNames(engine), ["prepare_brief_share", "read_task_status"]);
  assert.throws(
    () => engine.prepareBriefShare({ ...handles, draft_id: "draft_elsewhere" }),
    errorWithCode("DRAFT_MISMATCH"),
  );

  engine.prepareBriefShare({ ...handles, draft_id: briefDraft.draft_id });
  const state = engine.snapshot();
  assert.equal(state.task.state, "awaiting_human");
  assert.equal(state.task.lease.status, "read_only");
  assert.deepEqual(toolNames(engine), ["read_task_status"]);
});

test("WebMCP definitions expose only the current step and never authority or execution", async () => {
  const { engine } = makeHarness();
  const surfaces = [toolNames(engine)];
  const handles = engine.handles();
  engine.readResearchSources(handles);
  surfaces.push(toolNames(engine));
  const { brief_draft: briefDraft } = engine.composeResearchBrief({ ...handles, citation_style: "linked_endnotes" });
  surfaces.push(toolNames(engine));
  engine.prepareBriefShare({ ...handles, draft_id: briefDraft.draft_id });
  surfaces.push(toolNames(engine));
  await authorize(engine);
  surfaces.push(toolNames(engine));
  await engine.executeAuthorized();
  surfaces.push(toolNames(engine));

  assert.deepEqual(surfaces, [
    ["read_research_sources", "read_task_status"],
    ["compose_research_brief", "read_task_status"],
    ["prepare_brief_share", "read_task_status"],
    ["read_task_status"],
    [],
    ["read_receipt"],
  ]);
  assert.equal(findTool(engine, "read_receipt").annotations.readOnlyHint, true);
  assert.equal(surfaces.flat().some((name) => /authoriz|execut/i.test(name)), false);
});

test("a human-modified grant is exact-state, origin/task/lease, expiry, single-use, and digest bound", async () => {
  const origin = "https://research.example.test";
  const { engine } = makeHarness({ origin });
  const { handles } = await prepare(engine);
  engine.updateHumanDraft({ word_count: 1200, audience: "project_stewards" });

  const publicGrant = await authorize(engine);
  const state = engine.snapshot();
  const grant = state.authority.grant;
  assert.equal(state.authority.state, "granted");
  assert.equal(state.task.state, "authorized");
  assert.equal(state.task.lease.status, "revoked");
  assert.equal(grant.site_origin, origin);
  assert.equal(grant.task_id, handles.task_id);
  assert.equal(grant.lease_id, handles.lease_id);
  assert.equal(grant.operation, "share_research_brief");
  assert.equal(grant.single_use, true);
  assert.equal(grant.consumed_at, null);
  assert.equal(new Date(grant.expires_at) - new Date(grant.authorized_at), TEN_MINUTES_MS);
  assert.equal(grant.payload_digest, await sha256(grant.authorized_payload));
  assert.deepEqual(grant.human_modifications.map(({ field }) => field), ["audience", "word_count"]);
  assert.deepEqual(publicGrant, {
    grant_id: grant.grant_id,
    payload_digest: grant.payload_digest,
    expires_at: grant.expires_at,
  });
});

test("human-only confirmation is required and redacted from agent-visible surfaces", async () => {
  const { engine } = makeHarness();
  await prepare(engine);

  await assert.rejects(
    engine.grantAuthorization({ sharing_confirmation: false, collaborator_note_id: "note_fixture_3812" }),
    errorWithCode("CONFIRMATION_REQUIRED"),
  );
  await assert.rejects(
    engine.grantAuthorization({ sharing_confirmation: true, collaborator_note_id: "note_elsewhere" }),
    errorWithCode("NOTE_REFERENCE_REQUIRED"),
  );
  assert.equal(engine.snapshot().authority.state, "proposed");
  assertAgentSafe(createAgentToolDefinitions(engine));
});

test("matching execution completes once and returns a redacted matching receipt", async () => {
  const { engine } = makeHarness();
  const { handles } = await prepare(engine);
  engine.updateHumanDraft({ word_count: 1200, audience: "project_stewards" });
  await authorize(engine);

  const receipt = await engine.executeAuthorized();
  assert.equal(receipt.outcome, "executed");
  assert.deepEqual(receipt.comparison, { status: "match", matched: true, differences: [] });
  assert.deepEqual(receipt.executed_state, receipt.authorized_state);
  assert.equal(receipt.prepared_state.word_count, 900);
  assert.equal(receipt.authorized_state.word_count, 1200);
  assertAgentSafe(receipt);

  const completed = engine.snapshot();
  assert.equal(completed.task.state, "completed");
  assert.equal(completed.authority.state, "consumed");
  assert.ok(completed.authority.grant.consumed_at);
  const toolReceipt = await findTool(engine, "read_receipt").execute(handles);
  assert.equal(JSON.parse(toolReceipt).receipt_id, receipt.receipt_id);
  assertAgentSafe(toolReceipt);
  await assert.rejects(engine.executeAuthorized(), errorWithCode("GRANT_CONSUMED"));
});

test("single-use execution and authorization both fail closed under racing calls", async () => {
  const executionHarness = makeHarness();
  await prepare(executionHarness.engine);
  await authorize(executionHarness.engine);
  const executions = await Promise.allSettled([
    executionHarness.engine.executeAuthorized(),
    executionHarness.engine.executeAuthorized(),
  ]);
  assert.equal(executions.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(executions.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(executionHarness.engine.snapshot().event_log.filter(({ type }) => type === "authorization_consumed").length, 1);

  const authorizationHarness = makeHarness();
  await prepare(authorizationHarness.engine);
  const grants = await Promise.allSettled([authorize(authorizationHarness.engine), authorize(authorizationHarness.engine)]);
  assert.equal(grants.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(grants.find(({ status }) => status === "rejected").reason.code, "TASK_STATE_INVALID");
});

test("denial is terminal, performs no execution, and exposes a redacted receipt", async () => {
  const { engine } = makeHarness();
  const { handles } = await prepare(engine);
  const receipt = engine.denyAuthorization();

  assert.equal(receipt.outcome, "denied");
  assert.equal(receipt.authorized_state, null);
  assert.equal(receipt.executed_state, null);
  assert.equal(engine.snapshot().task.state, "cancelled");
  assert.deepEqual(toolNames(engine), ["read_receipt"]);
  assertAgentSafe(receipt);
  assert.equal(JSON.parse(await findTool(engine, "read_receipt").execute(handles)).outcome, "denied");
});

test("expired grants and expired brief drafts block before consumption with readable receipts", async () => {
  const grantHarness = makeHarness();
  const { handles: grantHandles } = await prepare(grantHarness.engine);
  await authorize(grantHarness.engine);
  grantHarness.advance(TEN_MINUTES_MS);
  await assert.rejects(grantHarness.engine.executeAuthorized(), errorWithCode("GRANT_EXPIRED"));
  assert.equal(grantHarness.engine.snapshot().authority.grant.consumed_at, null);
  assert.equal(grantHarness.engine.snapshot().receipt.outcome, "blocked_expired");
  assert.equal(JSON.parse(await findTool(grantHarness.engine, "read_receipt").execute(grantHandles)).outcome, "blocked_expired");

  const briefHarness = makeHarness();
  const { handles: briefHandles } = await prepare(briefHarness.engine);
  briefHarness.advance(THIRTY_MINUTES_MS - 1_000);
  await authorize(briefHarness.engine);
  briefHarness.advance(2_000);
  await assert.rejects(briefHarness.engine.executeAuthorized(), errorWithCode("BRIEF_EXPIRED"));
  assert.equal(briefHarness.engine.snapshot().authority.grant.consumed_at, null);
  assert.equal(briefHarness.engine.snapshot().receipt.outcome, "blocked_brief_expired");
  assert.equal(JSON.parse(await findTool(briefHarness.engine, "read_receipt").execute(briefHandles)).outcome, "blocked_brief_expired");
});

test("a divergent candidate is consumed, blocked before commit, and never presented as executed", async () => {
  let commitCalls = 0;
  const { engine } = makeHarness({
    executor: {
      async preflight(authorizedState) {
        return { ...authorizedState, word_count: authorizedState.word_count + 1 };
      },
      async commit(candidateState) {
        commitCalls += 1;
        return structuredClone(candidateState);
      },
    },
  });
  await prepare(engine);
  await authorize(engine);
  const receipt = await engine.executeAuthorized();

  assert.equal(commitCalls, 0);
  assert.equal(receipt.outcome, "blocked_divergent");
  assert.equal(receipt.executed_state, null);
  assert.deepEqual(receipt.comparison.differences.map(({ field }) => field), ["word_count"]);
  assert.equal(engine.snapshot().task.state, "blocked");
  assert.ok(engine.snapshot().authority.grant.consumed_at);
});

test("a divergent committed readback and executor failure stay truthful", async (t) => {
  await t.test("committed readback mismatch is retained", async () => {
    const { engine } = makeHarness({
      executor: {
        async preflight(authorizedState) {
          return structuredClone(authorizedState);
        },
        async commit(candidateState) {
          return { ...candidateState, word_count: candidateState.word_count + 1 };
        },
      },
    });
    await prepare(engine);
    await authorize(engine);
    const receipt = await engine.executeAuthorized();
    assert.equal(receipt.outcome, "executed_divergent");
    assert.equal(receipt.attempted_state.word_count, 900);
    assert.equal(receipt.executed_state.word_count, 901);
    assert.equal(engine.snapshot().task.state, "failed");
  });

  await t.test("executor error records unknown rather than a successful execution", async () => {
    const failure = new Error("local executor unavailable");
    const { engine } = makeHarness({
      executor: {
        async preflight() {
          throw failure;
        },
        async commit(candidateState) {
          return structuredClone(candidateState);
        },
      },
    });
    await prepare(engine);
    await authorize(engine);
    await assert.rejects(engine.executeAuthorized(), errorWithCode("EXECUTION_FAILED"));
    assert.equal(engine.snapshot().receipt.outcome, "execution_failed");
    assert.equal(engine.snapshot().receipt.comparison.status, "not_verified");
  });
});

test("the bounded executor deadline aborts stalled work and keeps the outcome unknown", async () => {
  let observedSignal;
  const { engine } = makeHarness({
    executionTimeoutMs: 10,
    executor: {
      preflight(authorizedState, { signal }) {
        observedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(structuredClone(authorizedState)), { once: true });
        });
      },
      async commit(candidateState) {
        return structuredClone(candidateState);
      },
    },
  });
  await prepare(engine);
  await authorize(engine);
  await assert.rejects(engine.executeAuthorized(), errorWithCode("EXECUTION_TIMEOUT"));
  assert.equal(observedSignal.aborted, true);
  assert.equal(engine.snapshot().receipt.outcome, "execution_failed");
});

test("protected inputs never reach the executor or unexpected receipt metadata", async () => {
  let executorReceived;
  const { engine } = makeHarness({
    executor: {
      async preflight(authorizedState) {
        executorReceived = structuredClone(authorizedState);
        return structuredClone(authorizedState);
      },
      async commit(candidateState) {
        return {
          ...candidateState,
          collaborator_note_ref_note_fixture_3812: "unexpected field names are not public evidence",
          "topic.note_fixture_3812": "dotted top-level names are not nested allowlisted fields",
          topic: {
            safe: "kept",
            collaborator_note_ref: "note_fixture_3812",
            human_only: { copied_collaborator_ref: "note_fixture_3812" },
          },
          metadata: {
            safe: "kept",
            guessed_collaborator_ref: "note_fixture_3812",
            human_only: { secret: "must-not-leak" },
          },
        };
      },
    },
  });
  await prepare(engine);
  await authorize(engine);
  await engine.executeAuthorized();
  const text = await findTool(engine, "read_receipt").execute(engine.handles());
  const receipt = JSON.parse(text);
  assert.equal("human_only" in executorReceived, false);
  assert.equal(receipt.outcome, "executed_divergent");
  assert.equal("metadata" in receipt.executed_state, false);
  assert.equal("topic" in receipt.executed_state, false);
  assert.deepEqual(receipt.comparison.differences, [
    { field: "[unexpected_field]", authorized_present: false, candidate_present: true, values_redacted: true },
    { field: "[unexpected_field]", authorized_present: false, candidate_present: true, values_redacted: true },
    { field: "topic", authorized_present: true, candidate_present: true, values_redacted: true },
    { field: "[unexpected_field]", authorized_present: false, candidate_present: true, values_redacted: true },
  ]);
  assert.equal(text.includes("human_only"), false);
  assert.equal(text.includes("note_fixture_3812"), false);
  assert.equal(text.includes("must-not-leak"), false);
});

test("state-machine surfaces are minimal during execution and terminal states", async (t) => {
  await t.test("running execution states expose no executable tools", async () => {
    let releasePreflight;
    let markPreflightStarted;
    const preflightStarted = new Promise((resolve) => {
      markPreflightStarted = resolve;
    });
    const { engine } = makeHarness({
      executionTimeoutMs: 1000,
      executor: {
        async preflight() {
          markPreflightStarted();
          return await new Promise((resolve) => {
            releasePreflight = resolve;
          });
        },
        async commit(candidateState) {
          return structuredClone(candidateState);
        },
      },
    });

    await prepare(engine);
    await authorize(engine);
    const running = engine.executeAuthorized().catch(() => {});
    await preflightStarted;
    assert.equal(engine.snapshot().task.state, "executing");
    assert.deepEqual(toolNames(engine), []);

    releasePreflight(structuredClone(engine.snapshot().authority.grant.authorized_payload));
    await running;
    assert.deepEqual(toolNames(engine), ["read_receipt"]);
  });

  await t.test("all terminal outcomes expose only read_receipt for downstream visibility", async (t) => {
    await t.test("denied", async () => {
      const { engine } = makeHarness();
      await prepare(engine);
      engine.denyAuthorization();
      assert.deepEqual(toolNames(engine), ["read_receipt"]);
    });

    await t.test("blocked by expired grant", async () => {
      const { engine, advance } = makeHarness();
      const { handles } = await prepare(engine);
      await authorize(engine);
      advance(TEN_MINUTES_MS);
      await assert.rejects(engine.executeAuthorized(), errorWithCode("GRANT_EXPIRED"));
      assert.deepEqual(toolNames(engine), ["read_receipt"]);
    });

    await t.test("blocked by expired prepared brief", async () => {
      const { engine, advance } = makeHarness();
      await prepare(engine);
      advance(THIRTY_MINUTES_MS - 1000);
      await authorize(engine);
      advance(1_500);
      await assert.rejects(engine.executeAuthorized(), errorWithCode("BRIEF_EXPIRED"));
      assert.deepEqual(toolNames(engine), ["read_receipt"]);
    });

    await t.test("blocked on preflight divergence", async () => {
      const { engine } = makeHarness({
        executor: {
          async preflight(authorizedState) {
            return { ...authorizedState, word_count: authorizedState.word_count + 1 };
          },
          async commit(candidateState) {
            return structuredClone(candidateState);
          },
        },
      });
      await prepare(engine);
      await authorize(engine);
      const receipt = await engine.executeAuthorized();
      assert.equal(receipt.outcome, "blocked_divergent");
      assert.deepEqual(toolNames(engine), ["read_receipt"]);
    });

    await t.test("failed execution remains terminal and read-only", async () => {
      const { engine } = makeHarness({
        executor: {
          async preflight() {
            throw new Error("executor-side fault");
          },
          async commit(candidateState) {
            return structuredClone(candidateState);
          },
        },
      });
      await prepare(engine);
      await authorize(engine);
      await assert.rejects(engine.executeAuthorized(), errorWithCode("EXECUTION_FAILED"));
      assert.deepEqual(toolNames(engine), ["read_receipt"]);
    });

    await t.test("successful execution lands in completed receipt-only surface", async () => {
      const { engine } = makeHarness();
      await prepare(engine);
      await authorize(engine);
      const receipt = await engine.executeAuthorized();
      assert.equal(receipt.outcome, "executed");
      assert.deepEqual(toolNames(engine), ["read_receipt"]);
    });
  });
});
