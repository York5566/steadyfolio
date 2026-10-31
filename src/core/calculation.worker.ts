import { analyze } from './engine';
import { problemCode, type Snapshot } from './schema';

self.onmessage = (event: MessageEvent<Snapshot>) => {
  try { self.postMessage({analysis: analyze(event.data)}); }
  catch (error) { self.postMessage({error: problemCode(error)}); }
};
