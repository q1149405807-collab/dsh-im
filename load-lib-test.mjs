/**
 * Load the fork-built lib/index.js bundle in Node and check it imports without
 * throwing at module level. This tells us whether the bundle is structurally
 * loadable or broken.
 */
import { pathToFileURL } from 'node:url';

const libPath = 'D:/aiwork/dsh-im/lib/index.js';
try {
  const mod = await import(pathToFileURL(libPath).href);
  console.log('fork-build lib LOADED OK, exports:', Object.keys(mod).slice(0, 20).join(','));
} catch (e) {
  console.error('fork-build lib LOAD FAILED:', e.message);
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
