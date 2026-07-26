/**
 * Sprint 3 — re-export claim store (receipt-store name kept for imports).
 */
export {
  createLearningClaimStore,
  createLearningClaimStore as createLearningReceiptStore,
  FileLearningClaimStore as FileLearningReceiptStore,
  GcsLearningClaimStore as GcsLearningReceiptStore,
} from './claim-store.js';
