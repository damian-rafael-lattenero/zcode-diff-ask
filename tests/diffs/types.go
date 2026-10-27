// Package types holds small declarations for the diff-ask fixture suite.

package types

// Record is the base unit stored by the fixture collector.
type Record struct {
	ID    int
	Kind  string
	Title string
	Tags  []string
}

// Collector gathers records with a bounded buffer.
type Collector struct {
	records []Record
	max     int
}

// NewCollector builds a collector with the given capacity.
func NewCollector(max int) *Collector {
	return &Collector{records: make([]Record, 0, max), max: max}
}

// Add appends a record, ignoring the call when full.
func (c *Collector) Add(r Record) bool {
	if len(c.records) >= c.max {
		return false
	}
	c.records = append(c.records, r)
	return true
}

// Len reports how many records were collected.
func (c *Collector) Len() int {
	return len(c.records)
}
