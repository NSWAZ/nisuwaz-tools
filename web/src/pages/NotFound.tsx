import { Starfield, SiteFooter } from "../components/ToolFrame";
import { Icon } from "../components/Icon";
import { linkProps, useDocumentTitle } from "../lib/router";

export default function NotFound() {
  useDocumentTitle("없는 페이지 · 니수와즈 도구 모음");
  return (
    <div className="tool-page">
      <Starfield />
      <main className="lost">
        <h1 id="page-title" tabIndex={-1}>
          이 항성계는 지도에 없어요
        </h1>
        <p>주소가 바뀌었거나 아직 없는 도구입니다.</p>
        <a className="btn btn-primary" {...linkProps("/", { transition: "back" })}>
          <Icon name="arrow-left" size={18} />
          성도로 돌아가기
        </a>
      </main>
      <SiteFooter />
    </div>
  );
}
