// The short-lived Worker that runs scrypt for one install-key seal or open.
// installKeySealRunner.ts spawns it and terminates it after one answer.

import { handleSealRequest, type SealRequest } from "./installKeySealRunner";

self.onmessage = (event: MessageEvent<SealRequest>) => {
	void handleSealRequest(event.data).then((response) => {
		self.postMessage(response);
	});
};
