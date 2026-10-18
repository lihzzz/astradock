/**
 * The deterministic benchmark prompt used by the integrated model test.
 *
 * Keep this prompt stable: changing the wording changes the task being
 * measured and makes results incomparable with the upstream codex-candy-eval
 * script.
 */
export const CODEX_CANDY_PROMPT = `Do not use any external tools to answer the following question:

A black bag contains candies with three flavors. Each flavor comes in two shapes, round and pentagram; the shapes can be distinguished by touch. The table gives the counts of each flavor and shape. Before the activity, a contestant must decide how many candies to draw. What is the minimum number of candies that guarantees having, in hand, an apple-flavored candy and a peach-flavored candy with different shapes? (Having a round apple candy with a pentagram peach candy, or a round peach candy with a pentagram apple candy, satisfies the requirement.)

             Apple  Peach  Watermelon
Round             7      9           8
Pentagram         7      6           4

Reply directly with your answer and a brief explanation. Do not call tools, read files, execute code, or ask another model to answer.`;

const CANDY_ANSWER_PATTERN = /(?<!\d)21(?!\d)/;

/** Match the upstream evaluator: an independent `21` marks a correct answer. */
export function gradeCodexCandyResponse(response: string): boolean {
  return CANDY_ANSWER_PATTERN.test(response);
}
