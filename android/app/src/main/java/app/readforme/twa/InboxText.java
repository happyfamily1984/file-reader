package app.readforme.twa;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 받은 글(마크다운일 수 있음)을 읽기 좋은 문장 목록으로 바꾼다.
 * 화면이 닫혀 있을 때도 앱이 스스로 읽을 수 있도록, 웹 쪽의 mdToPlain·textToChunks 와 같은 일을 한다.
 */
final class InboxText {
    static final class Doc {
        final List<String> texts = new ArrayList<>();
        /** texts 와 같은 길이. 그 문장이 새 문단의 첫 문장인지. */
        final List<Boolean> paragraphStart = new ArrayList<>();
    }

    private static final Pattern SPEAKABLE = Pattern.compile("[\\p{L}\\p{N}]");
    /** 문장 끝: 마침표·물음표·느낌표(뒤에 닫는 따옴표·괄호가 올 수 있음) 다음의 공백. "3.14" 처럼 공백이 없으면 나누지 않는다. */
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?。！？…][\"'”’)\\]]{0,3})\\s+");
    private static final Pattern TABLE_ROW = Pattern.compile("(?m)^[ \\t]*\\|(.*)\\|[ \\t]*$");

    private InboxText() { }

    /** 마크다운 기호(#, **, 표, 링크 등)를 걷어 낸다. */
    static String plain(String md) {
        String s = md.replace("\r\n", "\n").replace('\r', '\n');
        s = s.replaceAll("(?m)^[ \\t]*(```|~~~).*$", "");
        s = s.replaceAll("!\\[([^\\]]*)\\]\\([^)]*\\)", "$1");
        s = s.replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1");
        s = s.replaceAll("(?m)^[ \\t]*\\|?[ \\t:|-]*-{3,}[ \\t:|-]*\\|?[ \\t]*$", "");
        Matcher m = TABLE_ROW.matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            StringBuilder row = new StringBuilder();
            for (String cell : m.group(1).split("\\|")) {
                String c = cell.trim();
                if (c.isEmpty()) continue;
                if (row.length() > 0) row.append(", ");
                row.append(c);
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(row.toString()));
        }
        m.appendTail(sb);
        s = sb.toString();
        s = s.replaceAll("(?m)^[ \\t]{0,3}#{1,6}[ \\t]+", "");
        s = s.replaceAll("(?m)^[ \\t]*>+[ \\t]?", "");
        s = s.replaceAll("(?m)^[ \\t]*([-*+]|\\d+[.)])[ \\t]+(\\[[ xX]\\][ \\t]+)?", "");
        s = s.replaceAll("(\\*\\*|__|~~)(?=\\S)(.+?)(?<=\\S)\\1", "$2");
        s = s.replaceAll("(?m)(^|[\\s(])([*_])(?=\\S)([^*_\\n]+?)(?<=\\S)\\2(?=[\\s).,!?:;]|$)", "$1$3");
        s = s.replaceAll("`([^`\\n]+)`", "$1");
        s = s.replaceAll("</?[a-zA-Z][^>]*>", "");
        return s;
    }

    /** 줄(문단)과 문장 단위로 나눈다. 기호뿐인 조각은 앞 문장에 붙인다. */
    static Doc toDoc(String text) {
        Doc doc = new Doc();
        for (String line : plain(text).split("\n")) {
            String t = line.replaceAll("\\s+", " ").trim();
            if (t.isEmpty()) continue;
            boolean first = true;
            for (String piece : SENTENCE_END.split(t)) {
                String sentence = piece.trim();
                if (sentence.isEmpty()) continue;
                if (!SPEAKABLE.matcher(sentence).find() && !first) {
                    int last = doc.texts.size() - 1;
                    doc.texts.set(last, doc.texts.get(last) + " " + sentence);
                    continue;
                }
                doc.texts.add(sentence);
                doc.paragraphStart.add(first);
                first = false;
            }
        }
        return doc;
    }
}
