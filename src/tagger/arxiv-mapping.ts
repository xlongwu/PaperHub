/**
 * ArXiv category → domain tag mapping.
 */

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

export const ARXIV_DOMAIN_MAP: Record<string, string[]> = {
  "cs.AI": ["AI", "Foundation Models"],
  "cs.CL": ["NLP", "LLM"],
  "cs.LG": ["ML", "Training & Fine-Tuning"],
  "cs.CV": ["Multimodal", "Vision-Language"],
  "cs.IR": ["RAG", "Retrieval"],
  "cs.RO": ["Agents", "Robotics"],
  "cs.SE": ["Tools & Engineering"],
  "cs.CR": ["Safety & Alignment"],
  "cs.DB": ["RAG", "Vector DB"],
  "cs.DC": ["Distributed Systems"],
  "cs.HC": ["Human-Computer Interaction"],
  "cs.OS": ["Systems"],
  "cs.PL": ["Programming Languages"],
  "cs.SD": ["Software Engineering"],
  "cs.SY": ["Systems"],
  "stat.ML": ["ML", "Training & Fine-Tuning"],
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export function mapArxivCategories(categories: string[]): string[] {
  const tags = new Set<string>();

  for (const cat of categories) {
    const mapped = ARXIV_DOMAIN_MAP[cat];
    if (mapped) {
      for (const tag of mapped) {
        tags.add(tag);
      }
    }
  }

  return [...tags];
}
