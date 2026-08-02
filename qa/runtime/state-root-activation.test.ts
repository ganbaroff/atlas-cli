/**
 * R1 — state-root activation pack (P1 stub).
 * TODO(P2): fail-closed REQUIRED activation fixtures under os.tmpdir() only.
 */
import { describe, it } from 'vitest';

describe.skip('qa/runtime/state-root-activation (TODO P2)', () => {
  it.todo('REQUIRED=1 + missing manifest → activation_manifest_missing');
  it.todo('valid activation → assertStateRootActivated returns stores');
  it.todo('wrong ATLAS_STATE_ROOT → fail closed; no writes outside tmp');
});
