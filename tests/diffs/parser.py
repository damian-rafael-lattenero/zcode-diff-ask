"""Line-oriented tokenizer for the diff-ask fixture suite.

Marker words: alpha (words), bravo (numbers), charlie (symbols).
"""

import re
from dataclasses import dataclass
from typing import List

TOKEN_RE = re.compile(r"\s+|\w+|[^\s\w]+")


@dataclass
class Token:
    text: str
    start: int
    end: int


def tokenize_line(line: str) -> List[Token]:
    tokens = []
    for match in TOKEN_RE.finditer(line):
        tokens.append(Token(text=match.group(0), start=match.start(), end=match.end()))
    return tokens


def classify(token: Token) -> str:
    if token.text.strip() == "":
        return "whitespace"
    if re.match(r"^\w+$", token.text):
        return "alpha" if not token.text[0].isdigit() else "bravo"
    return "charlie"


def summarize(line: str) -> dict:
    tokens = tokenize_line(line)
    kinds = [classify(t) for t in tokens if t.text.strip()]
    return {
        "total": len(tokens),
        "words": kinds.count("alpha"),
        "numbers": kinds.count("bravo"),
        "symbols": kinds.count("charlie"),
    }
