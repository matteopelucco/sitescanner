// Vercel Function: consumer of the step messages of scans and inventories (spec §11.4, ADR-0018).
import { createStepConsumer } from '../src/vercel.js';

export default createStepConsumer();
