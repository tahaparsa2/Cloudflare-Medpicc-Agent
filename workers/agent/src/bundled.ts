/**
 * What ships inside the Worker: the context file, the fixture transcripts that
 * stand in for a real call recording source, and the recorded model answers
 * used when MODEL_MODE is "replay".
 */

import context from "../../../context/meddpicc.md";
import call1 from "../../../fixtures/calls/call-1.txt";
import call2 from "../../../fixtures/calls/call-2.txt";
import recorded1 from "../../../fixtures/recorded/call-1.json";
import recorded2 from "../../../fixtures/recorded/call-2.json";
import type { Recording } from "./model";

export const CONTEXT: string = context;

export const TRANSCRIPTS: Record<string, string | undefined> = {
  "call-1": call1,
  "call-2": call2,
};

export const RECORDINGS: Record<string, Recording | undefined> = {
  "call-1": recorded1,
  "call-2": recorded2,
};
