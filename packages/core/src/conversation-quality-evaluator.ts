import {
  countConversationQuestionIntents,
  hasRepeatedConversationPhrase,
  type ReplyLengthBucket,
} from "./conversation-quality.js";

export type EvaluatedReplyLengthBucket = ReplyLengthBucket | "empty";

export interface ConversationQualityFixture {
  id: string;
  obligationTopicIds: readonly string[];
  coveredTopicIds: readonly string[];
  replyText: string;
  expectedEmotion?: string | null;
  replyEmotion?: string | null;
  recentAssistantTexts: readonly string[];
}

export interface ConversationQualityEvaluation {
  fixtureId: string;
  replyObligationCoverage: number;
  followUpPresent: boolean;
  visibleLength: number;
  visibleLengthBucket: EvaluatedReplyLengthBucket;
  emotionalContinuity: boolean;
  repeatedPhrasing: boolean;
}

/** Deterministic, offline calibration seam. It never calls a model or reads time. */
export function evaluateConversationQualityFixture(
  fixture: ConversationQualityFixture,
): ConversationQualityEvaluation {
  const obligations = new Set(fixture.obligationTopicIds);
  const covered = new Set(
    fixture.coveredTopicIds.filter((topicId) => obligations.has(topicId)),
  );
  const visibleLength = [
    ...fixture.replyText.replace(/\s|\[表情:[^\]]+\]/gu, ""),
  ].length;
  const repeatedPhrasing = hasRepeatedConversationPhrase(
    fixture.replyText,
    fixture.recentAssistantTexts,
  );
  const expectedEmotion = fixture.expectedEmotion?.trim() || null;
  const replyEmotion = fixture.replyEmotion?.trim() || null;
  return {
    fixtureId: fixture.id,
    replyObligationCoverage:
      obligations.size === 0 ? 1 : covered.size / obligations.size,
    followUpPresent: countConversationQuestionIntents(fixture.replyText) > 0,
    visibleLength,
    visibleLengthBucket:
      visibleLength === 0
        ? "empty"
        : visibleLength <= 20
          ? "short"
          : visibleLength <= 60
            ? "normal"
            : "long",
    emotionalContinuity:
      expectedEmotion === null || expectedEmotion === replyEmotion,
    repeatedPhrasing,
  };
}
