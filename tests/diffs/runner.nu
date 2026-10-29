# Helper commands for the diff-ask fixture panel (nushell).

def "main size" [path: path] {
  let entries = (ls $path | sort-by name)
  let total = ($entries | get size | math sum)
  echo $"alpha total: ($total)"
}

def "main alpha" [] {
  # Marker words: alpha (commands), bravo (tables), charlie (strings).
  let rows = ([[name, kind]; [alpha, one] [bravo, two] [charlie, three]])
  $rows | where kind == one
}

def main [] {
  main alpha
}
