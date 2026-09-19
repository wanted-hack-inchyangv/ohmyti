import { LinkButton, PageContainer, PageHeader } from "@/components/ui";

export default function EvaluationNotFound() {
  return (
    <PageContainer width="narrow">
      <PageHeader
        title="평가를 찾을 수 없습니다"
        description="ID가 잘못되었거나 제출이 삭제되어 평가를 열 수 없습니다."
      />
      <div className="flex flex-wrap gap-2">
        <LinkButton href="/submissions/new" variant="primary" size="lg">
          새 제출 만들기
        </LinkButton>
        <LinkButton href="/demo" variant="secondary" size="lg">
          샘플 체험
        </LinkButton>
      </div>
    </PageContainer>
  );
}
