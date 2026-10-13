import { describe, expect, it, vi } from "vitest";
import { streamCoral, BASE_URL } from "../index";
import { fixtureCatalog } from "./model-fixtures";
const catalog = fixtureCatalog();
const model = (api = "openai-responses", id = catalog[0].id) => ({...catalog.find(m=>m.id === id)!, provider:"coralbricks", baseUrl:BASE_URL, api});
const user = {role:"user", content:"Hello", timestamp:1};
function sse(events: object[]) {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {headers:{"content-type":"text/event-stream"}});
}
function completed(output: object[] = []) {
  return {type:"response.completed", response:{id:"resp_test",status:"completed",output,usage:{input_tokens:20,output_tokens:4,total_tokens:24,input_tokens_details:{cached_tokens:5,cache_write_tokens:3}}}};
}
function textEvents(text = "Hi 🌊") {
  const item = {type:"message",id:"msg_test",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]};
  return [{type:"response.output_item.added",output_index:0,item:{...item,content:[]}}, {type:"response.output_text.delta",output_index:0,content_index:0,delta:text}, {type:"response.output_item.done",output_index:0,item}, completed([item])];
}
async function probe(m = model(), context:any = {messages:[user]}, options:any = {}, events = textEvents()) {
  let payload:any;
  let url = "";
  const fetch = vi.fn(async (input:any, init:any) => {url=String(input);payload=JSON.parse(init.body);return sse(events);});
  const stream = streamCoral(m, context, {apiKey:"test-key", fetch, maxRetries:0, ...options} as any);
  const types:string[]=[];
  for await (const event of stream) types.push(event.type);
  return {payload,url,types,result:await stream.result(),fetch};
}

describe("native Responses stream", () => {
  it("streams Unicode text and accounts for cache writes, reads, and cost", async () => {
    const p = await probe();
    expect(p.url).toBe(`${BASE_URL}/responses`);
    expect(p.payload).toMatchObject({stream:true,store:false,reasoning:{effort:"none"}});
    expect(p.payload.previous_response_id).toBeUndefined();
    expect(p.result.content[0]).toMatchObject({type:"text",text:"Hi 🌊"});
    expect(p.result.usage).toMatchObject({input:12,output:4,cacheRead:5,cacheWrite:3,totalTokens:24});
    expect(p.result.usage.cost.total).toBeGreaterThan(0);
    expect(p.types).toEqual(["start","text_start","text_delta","text_end","done"]);
    expect(p.result.api).toBe("openai-responses");
  });
  it.each(catalog.map(m=>m.id))("maps reasoning off/low/max and clamped medium for %s", async (id) => {
    for (const [reasoning,effort] of [["off","none"],["low","low"],["max","max"],["medium","high"]]) {
      const p = await probe(model("openai-responses",id), undefined, {reasoning,maxTokens:128});
      expect(p.payload.reasoning.effort).toBe(effort);
      expect(p.payload.max_output_tokens).toBe(128);
      expect(p.payload.thinking).toBeUndefined();
      expect(p.payload.reasoning_effort).toBeUndefined();
    }
  });
  it("preserves payload replacements and response hooks", async () => {
    const onPayload = vi.fn(async (p:any) => ({...p,temperature:0.3}));
    const onResponse = vi.fn();
    const p = await probe(undefined, undefined, {onPayload,onResponse});
    expect(p.payload.temperature).toBe(0.3);
    expect(onPayload).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({status:200}), expect.objectContaining({api:"openai-responses"}));
  });
  it("handles empty completed responses and rejects partial streams", async () => {
    expect((await probe(undefined,undefined,{},[completed()])).result.stopReason).toBe("stop");
    const p = await probe(undefined,undefined,{},textEvents().slice(0,-1));
    expect(p.result.stopReason).toBe("error");
    expect(p.types.at(-1)).toBe("error");
  });
  it("propagates aborts and provider errors", async () => {
    const result = await streamCoral(model(), {messages:[user]}, {apiKey:"test",signal:AbortSignal.abort(),maxRetries:0} as any).result();
    expect(result.stopReason).toBe("aborted");
    const p = await probe(undefined, undefined, {fetch:async()=>Response.json({error:{message:"context_length_exceeded",code:"context_length_exceeded"}}, {status:400})});
    expect(p.result.stopReason).toBe("error");
    expect(p.result.errorMessage).toContain("context_length_exceeded");
  });
  it("streams tool arguments and replays tool results in full", async () => {
    const item = {type:"function_call",id:"fc_test",call_id:"call_test",name:"lookup",arguments:'{"city":"Paris"}',status:"completed"};
    const events = [{type:"response.output_item.added",output_index:0,item:{...item,arguments:""}}, {type:"response.function_call_arguments.delta",output_index:0,delta:item.arguments}, {type:"response.output_item.done",output_index:0,item}, completed([item])];
    const tools = [{name:"lookup",description:"Lookup city",parameters:{type:"object",properties:{city:{type:"string"}},required:["city"]}}];
    const first = await probe(undefined, {messages:[{role:"system",content:"Use tools",toolsAdded:tools,timestamp:0},user]}, {}, events);
    expect(first.result.stopReason).toBe("toolUse");
    const call:any = first.result.content[0];
    expect(call).toMatchObject({type:"toolCall",name:"lookup",arguments:{city:"Paris"}});
    const next = await probe(undefined, {messages:[{role:"system",content:"Use tools",toolsAdded:tools,timestamp:0},user,first.result,{role:"toolResult",toolCallId:call.id,toolName:call.name,content:[{type:"text",text:"Sunny"}],isError:false,timestamp:2}]});
    expect(next.payload.input).toEqual(expect.arrayContaining([expect.objectContaining({type:"function_call",name:"lookup"}),expect.objectContaining({type:"function_call_output",output:"Sunny"})]));
    expect(next.payload.tools[0]).toMatchObject({type:"function",name:"lookup"});
  });
  it("accepts image input and chat-completions history handoff", async () => {
    const assistant = {...(await probe()).result,api:"openai-completions",content:[{type:"text",text:"Earlier reply"}]};
    const p = await probe(undefined, {messages:[user,assistant,{...user,content:[{type:"image",mimeType:"image/png",data:"cG5n"},{type:"text",text:"Describe"}]}]});
    expect(p.payload.input.at(-1).content[0]).toMatchObject({type:"input_image",image_url:"data:image/png;base64,cG5n"});
    expect(JSON.stringify(p.payload.input)).toContain("Earlier reply");
  });
  it("keeps Chat Completions routing and GLM off semantics unchanged", async () => {
    const p = await probe(model("openai-completions","glm-5.3-fast"), undefined, {reasoning:"off"});
    expect(p.url).toBe(`${BASE_URL}/chat/completions`);
    expect(p.payload).toMatchObject({thinking:{type:"disabled"}});
    expect(p.payload.input).toBeUndefined();
  });
  it("surfaces Responses errors without retrying through Chat Completions", async () => {
    const fetch = vi.fn(async () => Response.json({error:{message:"The request was invalid."}}, {status:400}));
    const p = await probe(undefined, undefined, {fetch});
    expect(p.result.stopReason).toBe("error");
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain("/responses");
  });
  it("rejects missing credentials before sending", () => {
    expect(()=>streamCoral(model(),{messages:[]})).toThrow("No API key for CoralBricks");
  });
});

describe("session id", () => {
  async function requestFor(api: string, options: any = {}) {
    let headers = new Headers();
    let body: any;
    const fetch = vi.fn(async (_input:any, init:any) => {
      headers = new Headers(init.headers);
      body = JSON.parse(init.body);
      return api === "openai-responses" ? sse(textEvents()) : sse([
        {id:"c",object:"chat.completion.chunk",created:0,model:"m",choices:[{index:0,delta:{role:"assistant",content:"Hi"},finish_reason:null}]},
        {id:"c",object:"chat.completion.chunk",created:0,model:"m",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}},
      ]);
    });
    await streamCoral(model(api), {messages:[user]}, {apiKey:"k", fetch, maxRetries:0, sessionId:"pi-session-1", ...options} as any).result();
    expect(fetch).toHaveBeenCalledOnce();
    return {headers, body};
  }
  // Coral groups a conversation's turns by the first session id it finds: a session
  // header, else the body's prompt_cache_key.
  it("sends pi's session id on Chat Completions as x-session-affinity", async () => {
    expect((await requestFor("openai-completions")).headers.get("x-session-affinity")).toBe("pi-session-1");
  });
  it("sends pi's session id on Responses as prompt_cache_key", async () => {
    expect((await requestFor("openai-responses")).body.prompt_cache_key).toBe("pi-session-1");
  });
  it("also sends Coral's own session header and the body key on Chat Completions", async () => {
    const {headers, body} = await requestFor("openai-completions");
    expect(headers.get("x-coral-session")).toBe("pi-session-1");
    expect(body.prompt_cache_key).toBe("pi-session-1");
  });
  it("sends Coral's own session header on Responses", async () => {
    expect((await requestFor("openai-responses")).headers.get("x-coral-session")).toBe("pi-session-1");
  });
  it("adds no session fields when pi has no session id", async () => {
    const {headers, body} = await requestFor("openai-completions", {sessionId: undefined});
    expect(headers.get("x-coral-session")).toBeNull();
    expect(headers.get("x-session-affinity")).toBeNull();
    expect(body.prompt_cache_key).toBeUndefined();
  });
  it("keeps the session header but drops the cache key when caching is off", async () => {
    const {headers, body} = await requestFor("openai-completions", {cacheRetention: "none"});
    expect(headers.get("x-coral-session")).toBe("pi-session-1");
    expect(body.prompt_cache_key).toBeUndefined();
  });
});
