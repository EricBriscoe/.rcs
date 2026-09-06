export async function askUser({ question, choices }, ctx, signal) {
  signal?.throwIfAborted();
  const result = (status, answer = null, source = null) => ({
    content: [{ type: "text", text: JSON.stringify({ question, status, answer, source }) }],
    details: { question, status, answer, source },
    ...(status === "unavailable" ? { isError: true } : {}),
  });
  if (!ctx.hasUI) return result("unavailable");

  let answer;
  let source = "text";
  if (choices?.length) {
    const labels = choices.map((choice, index) => `${index + 1}. ${choice}`);
    const custom = "Type an answer…";
    const selected = await ctx.ui.select(question, [...labels, custom], { signal });
    signal?.throwIfAborted();
    if (selected === undefined) return result("cancelled");
    if (selected === custom) {
      answer = await ctx.ui.input(question, "Your answer", { signal });
    } else {
      const index = labels.indexOf(selected);
      if (index < 0) return result("cancelled");
      answer = choices[index];
      source = "choice";
    }
  } else {
    answer = await ctx.ui.input(question, "Your answer", { signal });
  }
  signal?.throwIfAborted();
  if (answer === undefined) return result("cancelled");
  if (!answer.trim()) return result("empty");
  return result("answered", answer, source);
}
