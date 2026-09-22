---
uid: aa11bb22
id: cohub.shared.consensus.algorithm
parent: cohub.shared.consensus
name: {zh: "分词与共识判定", en: "Tokenization & Consensus Detection"}
description:
  zh: >
      A类零依赖分词（tokenize / jaccard）+ B类成对一致性（pairwiseAgreement）与多模型共识判定（computeConsensus）。2n/3规则：≥ceil(2n/3)名议员平均一致性达阈值即共识。
      
  en: >
      Class-A zero-dep tokenization (tokenize/jaccard) + class-B pairwise agreement and multi-model consensus detection (computeConsensus). 2n/3 rule: consensus when ≥ceil(2n/3) councillors reach threshold agreement.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.364Z"
fingerprint: 16ec1b797750760deb69e2b63a377c124816c2788946e74f61907b1898214e2b
source:
  - path: "cohub-shared/src/consensus.ts"
    line: 99
    end_line: 114
  - path: "cohub-shared/src/consensus.ts"
    line: 234
    end_line: 269
apis:
  - protocol: rpc
    path: "tokenize"
    description:
      zh: >
          文本分词：小写→非字母数字+中文切分→去停用词
          
      en: >
          Tokenize: lowercase→split non-alpha+CJK→remove stopwords
          
  - protocol: rpc
    path: "jaccard"
    description:
      zh: >
          两个token集合的Jaccard重叠系数
          
      en: >
          Jaccard overlap between two token sets
          
  - protocol: rpc
    path: "pairwiseAgreement"
    description:
      zh: >
          两个CouncillorSummary的成对一致性：0.5×结论重叠+0.5×实体重叠
          
      en: >
          Pairwise agreement: 0.5×conclusion overlap + 0.5×entity overlap
          
  - protocol: rpc
    path: "computeConsensus"
    description:
      zh: >
          多模型共识判定：≥ceil(2n/3)议员平均一致性≥阈值即共识
          
      en: >
          Multi-model consensus: ≥ceil(2n/3) councillors with avg agreement ≥ threshold
          
---
