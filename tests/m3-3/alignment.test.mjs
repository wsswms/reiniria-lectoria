import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { alignRevisionSegments } from "../../src/document/alignment.mjs";

const segment = (text, path, id = randomUUID(), kind = "paragraph") => ({ segmentId: id, sourceText: text, structuralPath: path, kind });

test("unchanged, moved, inserted and unique light edits align without wrong reuse", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const previous = [segment("Alpha stable paragraph.", "/0", ids[0]), segment("Beta stable paragraph.", "/1", ids[1]), segment("Gamma original wording.", "/2", ids[2])];
  const incoming = [segment("Beta stable paragraph.", "/0"), segment("Alpha stable paragraph.", "/1"), segment("Gamma original wording updated.", "/2"), segment("New paragraph.", "/3")];
  const result = alignRevisionSegments(previous, incoming);
  assert.deepEqual(result.aligned.map((item) => item.status), ["moved", "moved", "changed", "inserted"]);
  assert.deepEqual(result.aligned.map((item) => item.oldSegmentId), [ids[1], ids[0], ids[2], undefined]);
  assert.equal(result.requiresConfirmation, false);
  assert.deepEqual(result.deleted, []);
});

test("deleted segments remain historical and do not enter the incoming revision", () => {
  const retainedId = randomUUID();
  const deletedId = randomUUID();
  const result = alignRevisionSegments(
    [segment("Retained paragraph.", "/0", retainedId), segment("Deleted paragraph.", "/1", deletedId)],
    [segment("Retained paragraph.", "/0")],
  );
  assert.equal(result.aligned[0].oldSegmentId, retainedId);
  assert.deepEqual(result.deleted, [{ segmentId: deletedId, status: "deleted", structuralPath: "/1" }]);
});

test("split, merge and duplicate text are always ambiguous", () => {
  const split = alignRevisionSegments(
    [segment("One sentence and another sentence.", "/0")],
    [segment("One sentence", "/0"), segment("and another sentence.", "/1")],
  );
  assert.deepEqual(split.aligned.map((item) => item.status), ["ambiguous", "ambiguous"]);
  const merged = alignRevisionSegments(
    [segment("First part", "/0"), segment("second part", "/1")],
    [segment("First part second part", "/0")],
  );
  assert.deepEqual(merged.aligned.map((item) => item.status), ["ambiguous"]);
  const duplicate = alignRevisionSegments(
    [segment("Repeat", "/0"), segment("Repeat", "/1")],
    [segment("Repeat", "/0"), segment("Repeat", "/1")],
  );
  assert.deepEqual(duplicate.aligned.map((item) => item.status), ["ambiguous", "ambiguous"]);
  assert.ok([...split.aligned, ...merged.aligned, ...duplicate.aligned].every((item) => item.oldSegmentId === undefined));
});

test("near-equal competing candidates remain ambiguous instead of guessing", () => {
  const result = alignRevisionSegments(
    [segment("The camera uses a bright optical finder.", "/old/0"), segment("The camera uses a clear optical finder.", "/old/1")],
    [segment("The camera uses a crisp optical finder.", "/new/0")],
  );
  assert.equal(result.aligned[0].status, "ambiguous");
  assert.equal(result.aligned[0].oldSegmentId, undefined);
});
