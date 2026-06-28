import ar from "./ar.json";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fa from "./fa.json";
import fr from "./fr.json";
import id from "./id.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import nl from "./nl.json";
import pl from "./pl.json";
import ptBr from "./pt-br.json";
import pt from "./pt.json";
import ru from "./ru.json";
import th from "./th.json";
import tr from "./tr.json";
import uk from "./uk.json";
import vi from "./vi.json";
import zhCn from "./zh-cn.json";
import zhTw from "./zh-tw.json";

export const BUILTIN_I18N: Record<string, Record<string, string>> = {
  ar,
  de,
  en,
  es,
  fa,
  fr,
  id,
  it,
  ja,
  ko,
  nl,
  pl,
  pt,
  "pt-br": ptBr,
  ru,
  th,
  tr,
  uk,
  vi,
  "zh-cn": zhCn,
  "zh-tw": zhTw
};
