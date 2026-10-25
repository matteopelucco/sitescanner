// Vercel Function: every request is routed here by vercel.json (spec §11.1).
import { createVercelHandler } from '../src/vercel.js';

export default createVercelHandler();
