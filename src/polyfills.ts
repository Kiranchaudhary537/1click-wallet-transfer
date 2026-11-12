// Own module so it runs before any chain SDK loads: imports are evaluated in order, before the importer's body.
import { Buffer } from 'buffer';

(globalThis as any).Buffer ??= Buffer; // @solana/spl-token uses a global Buffer at load time
