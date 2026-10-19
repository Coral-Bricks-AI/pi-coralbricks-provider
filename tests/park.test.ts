import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamCoral, buildModels, BASE_URL } from "../index";
import { clearParked, planPark } from "../park";
import models from "../models.json";
import patches from "../patch.json";

const catalog = buildModels(models as any, [], patches as any);
const model = (id = catalog[0].id) => ({...catalog.find(m=>m.id === id)!, provider:"coralbricks", baseUrl:BASE_URL, api:"openai-responses"});
const tools = [{name:"lookup",description:"Lookup city",parameters:{type:"object",properties:{city:{type:"string"}},required:["city"]}}];
const system = {role:"system", content:"Use tools", toolsAdded:tools, timestamp:0};
const user = (content: string, timestamp = 1) => ({role:"user", content, timestamp});

function sse(events: object[]) {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {headers:{"content-type":"text/event-stream"}});
}
function completed(id: string, output: object[]) {
  return {type:"response.completed", response:{id,status:"completed",output,usage:{input_tokens:20,output_tokens:4,total_tokens:24}}};
}
function text(id: string, value = "Hi") {
  const item = {type:"message",id:`msg_${id}`,role:"assistant",status:"completed",content:[{type:"output_text",text:value,annotations:[]}]};
  return [{type:"response.output_item.added",output_index:0,item:{...item,content:[]}}, {type:"response.output_text.delta",output_index:0,content_index:0,delta:value}, {type:"response.output_item.done",output_index:0,item}, completed(id, [item])];
}
function toolCall(id: string) {
  const item = {type:"function_call",id:`fc_${id}`,call_id:`call_${id}`,name:"lookup",arguments:'{"city":"Paris"}',status:"completed"};
  return [{type:"response.output_item.added",output_index:0,item:{...item,arguments:""}}, {type:"response.function_call_arguments.delta",output_index:0,delta:item.arguments}, {type:"response.output_item.done",output_index:0,item}, completed(id, [item])];
}

async function turn(messages: any[], events: object[] | ((n: number) => Response), opts: {park?: boolean; m?: any; options?: any} = {}) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_input: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return typeof events === "function" ? events(bodies.length) : sse(events);
  });
  const stream = streamCoral(opts.m ?? model(), {messages}, {apiKey:"test-key", fetch, maxRetries:0, ...opts.options} as any, {park: opts.park ?? true});
  for await (const _ of stream) { /* drain */ }
  const result = await stream.result();
  await Promise.resolve();
  return {payload: bodies[0], bodies, result, fetch};
}

beforeEach(() => clearParked());

describe("Responses parking", () => {
  it("stores the first turn and sends the full transcript", async () => {
    const t = await turn([system, user("Hello")], text("r1"));
    expect(t.payload.store).toBe(true);
    expect(t.payload.previous_response_id).toBeUndefined();
    expect(t.payload.input).toHaveLength(2);
    expect(t.result.responseId).toBe("r1");
  });

  it("sends only the new user message on the next turn", async () => {
    const first = await turn([system, user("Hello")], text("r1"));
    const next = await turn([system, user("Hello"), first.result, user("Again", 2)], text("r2"));
    expect(next.payload.previous_response_id).toBe("r1");
    expect(next.payload.store).toBe(true);
    expect(next.payload.input).toEqual([expect.objectContaining({role:"user"})]);
    expect(next.payload.tools[0]).toMatchObject({type:"function",name:"lookup"});
  });

  it("chains tool results and keeps chaining", async () => {
    const first = await turn([system, user("Weather?")], toolCall("r1"));
    const call: any = first.result.content[0];
    const result = {role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:"Sunny"}],isError:false,timestamp:2};
    const second = await turn([system, user("Weather?"), first.result, result], text("r2", "Sunny"));
    expect(second.payload.previous_response_id).toBe("r1");
    expect(second.payload.input).toEqual([expect.objectContaining({type:"function_call_output",output:"Sunny"})]);
    const third = await turn([system, user("Weather?"), first.result, result, second.result, user("Thanks", 3)], text("r3"));
    expect(third.payload.previous_response_id).toBe("r2");
    expect(third.payload.input).toHaveLength(1);
  });

  it("replays in full when earlier history changed", async () => {
    const first = await turn([system, user("Hello")], text("r1"));
    const next = await turn([system, user("Edited"), first.result, user("Again", 2)], text("r2"));
    expect(next.payload.previous_response_id).toBeUndefined();
    expect(next.payload.input).toHaveLength(4);
    expect(next.payload.store).toBe(true);
  });

  it("replays in full after a model switch", async () => {
    // The catalog may hold a single model, so switch to a copy under another id.
    const first = await turn([system, user("Hello")], text("r1"), {m: model()});
    const next = await turn([system, user("Hello"), first.result, user("Again", 2)], text("r2"), {m: {...model(), id: "other-model"}});
    expect(next.payload.previous_response_id).toBeUndefined();
  });

  it("replays in full when the parent was never parked", async () => {
    const first = await turn([system, user("Hello")], text("r1"), {park: false});
    expect(first.payload.store).toBe(false);
    const next = await turn([system, user("Hello"), first.result, user("Again", 2)], text("r2"));
    expect(next.payload.previous_response_id).toBeUndefined();
  });

  it("does not park failed turns", async () => {
    const failed = await turn([system, user("Hello")], text("r1").slice(0, -1));
    expect(failed.result.stopReason).toBe("error");
    const plan = planPark({input:[{role:"user",content:"x"}]}, [{role:"assistant",responseId:"r1",provider:"coralbricks",api:"openai-responses",model:catalog[0].id,stopReason:"stop"}], model());
    expect(plan.params.previous_response_id).toBeUndefined();
  });

  it("re-sends the full transcript once when Coral lost the parent", async () => {
    const first = await turn([system, user("Hello")], text("r1"));
    const missing = Response.json({error:{message:"previous response 'r1' not found",type:"invalid_request_error",param:null,code:"previous_response_not_found"}}, {status:404});
    const next = await turn([system, user("Hello"), first.result, user("Again", 2)], (n) => n === 1 ? missing : sse(text("r2")));
    expect(next.fetch).toHaveBeenCalledTimes(2);
    expect(next.bodies[0].previous_response_id).toBe("r1");
    expect(next.bodies[1].previous_response_id).toBeUndefined();
    expect(next.bodies[1].input).toHaveLength(4);
    expect(next.result.stopReason).toBe("stop");
    const after = await turn([system, user("Hello"), first.result, user("Again", 2), next.result, user("More", 3)], text("r3"));
    expect(after.payload.previous_response_id).toBe("r2");
  });

  it("passes other errors through without a retry", async () => {
    const first = await turn([system, user("Hello")], text("r1"));
    const next = await turn([system, user("Hello"), first.result, user("Again", 2)], () => Response.json({error:{message:"context_length_exceeded",code:"context_length_exceeded"}}, {status:400}));
    expect(next.fetch).toHaveBeenCalledOnce();
    expect(next.result.errorMessage).toContain("context_length_exceeded");
  });

  it("runs caller payload hooks before planning", async () => {
    const onPayload = vi.fn(async (p: any) => ({...p, temperature: 0.3}));
    const t = await turn([system, user("Hello")], text("r1"), {options: {onPayload}});
    expect(onPayload).toHaveBeenCalledOnce();
    expect(t.payload).toMatchObject({temperature: 0.3, store: true});
  });
});
