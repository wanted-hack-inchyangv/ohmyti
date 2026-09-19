import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@ohmyti/analysis",
    // fixtures/는 mutation 대상 제출물 픽스처다. 픽스처의 제출 테스트는 이 패키지의 테스트가 아니다
    exclude: [...configDefaults.exclude, "fixtures/**"],
  },
});
