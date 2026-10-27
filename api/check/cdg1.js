// Vercel Function of the region cdg1: runs the checks that the main one asks for (spec §13.6, RF-LOC-02).
import { createCheckHandler } from '../../src/vercel.js';

export default createCheckHandler();
