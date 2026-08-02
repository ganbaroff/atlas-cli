# E01 — State activation (eval stub)

**Status:** TODO P3 — not executed by P1 runner.  
**Purpose:** Fail-closed activated root under `ATLAS_STATE_ROOT_REQUIRED=1`.  
**Inputs:** tmp fixture root ± manifest/receipts.  
**Expected receipt:** PASS/FAIL + error code; no writes outside tmp.  
**Forbidden:** production `~\.atlas\state`.
