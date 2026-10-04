// Typed postMessage envelopes between the main thread and the DB Worker. The
// Worker owns the opfs-sahpool SQLite database; the main thread only sends
// requests + awaits replies. Discriminated unions on `kind` / `ok` keep the
// bridge type-safe — the same shape as @amlfilter/browser engine/protocol.ts.

import type {
	CreateCustomerPayload,
	CustomerPatch,
	CustomerRow,
	MatchEvent,
	ReviewFilters,
	ReviewRow,
	TieredMatch,
} from "../types";

export type DbRequest =
	| { readonly kind: "open"; readonly id: number }
	| {
			readonly kind: "createCustomer";
			readonly id: number;
			readonly payload: CreateCustomerPayload;
	  }
	| {
			readonly kind: "createCustomers";
			readonly id: number;
			readonly payloads: ReadonlyArray<CreateCustomerPayload>;
	  }
	| { readonly kind: "listCustomers"; readonly id: number }
	| {
			readonly kind: "getCustomer";
			readonly id: number;
			readonly customerId: string;
	  }
	| {
			readonly kind: "updateCustomer";
			readonly id: number;
			readonly customerId: string;
			readonly patch: CustomerPatch;
	  }
	| {
			readonly kind: "deleteCustomer";
			readonly id: number;
			readonly customerId: string;
	  }
	| {
			readonly kind: "recordMatches";
			readonly id: number;
			readonly customerId: string;
			readonly matches: ReadonlyArray<TieredMatch>;
	  }
	| {
			readonly kind: "replaceMatches";
			readonly id: number;
			readonly customerId: string;
			readonly matches: ReadonlyArray<TieredMatch>;
	  }
	| {
			readonly kind: "markScreened";
			readonly id: number;
			readonly customerId: string;
			readonly listVersion: string;
	  }
	| {
			readonly kind: "listReviewMatches";
			readonly id: number;
			readonly filters: ReviewFilters;
	  }
	| {
			readonly kind: "resolveMatch";
			readonly id: number;
			readonly matchId: string;
			readonly resolution: string;
			readonly reviewerId?: string;
			readonly notes?: string;
	  }
	| {
			readonly kind: "getMatchEvents";
			readonly id: number;
			readonly matchId: string;
	  }
	| { readonly kind: "getSetting"; readonly id: number; readonly key: string }
	| {
			readonly kind: "setSetting";
			readonly id: number;
			readonly key: string;
			readonly value: string;
	  };

interface DbOk<K extends DbRequest["kind"], R> {
	readonly ok: true;
	readonly id: number;
	readonly kind: K;
	readonly result: R;
}

export interface DbErr {
	readonly ok: false;
	readonly id: number;
	/** encodeWorkerError() output — "CODE|message" or a plain message. */
	readonly error: string;
}

export type DbResponse =
	| DbOk<"open", number>
	| DbOk<"createCustomer", CustomerRow>
	| DbOk<"createCustomers", ReadonlyArray<CustomerRow>>
	| DbOk<"listCustomers", ReadonlyArray<CustomerRow>>
	| DbOk<"getCustomer", CustomerRow | null>
	| DbOk<"updateCustomer", CustomerRow>
	| DbOk<"deleteCustomer", null>
	| DbOk<"recordMatches", ReadonlyArray<ReviewRow>>
	| DbOk<"replaceMatches", ReadonlyArray<ReviewRow>>
	| DbOk<"markScreened", CustomerRow>
	| DbOk<"listReviewMatches", ReadonlyArray<ReviewRow>>
	| DbOk<"resolveMatch", ReviewRow>
	| DbOk<"getMatchEvents", ReadonlyArray<MatchEvent>>
	| DbOk<"getSetting", string | null>
	| DbOk<"setSetting", null>
	| DbErr;
