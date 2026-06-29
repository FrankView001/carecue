import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('server/agent/agent.v3.test.ts', 'r', encoding='utf-8') as f:
    content = f.read()

new_tests = """
  // ===================================================================
  // 皮肤科 (Dermatology) v4.7 - v4.9
  // ===================================================================

  {
    // v4.7：痤疮 — 完整假设驱动流程，含初始假设、搜索、报告
    name: 'v4.7 痤疮-完整假设驱动 -> 假设生成、搜索验证、输出护理建议',
    run: async () => {
      const { runtime, search } = createRuntime({
        llm: {
          initial_hypothesis: {
            hypotheses: [
              {
                name: '寻常痤疮',
                likelihood: 'more_likely',
                supportEvidence: ['面颊和下巴多发', '熬夜后加重', '典型粉刺和炎性丘疹'],
                againstEvidence: ['无全身症状'],
                missingInfo: ['既往是否有类似发作', '是否使用过护肤品或药物'],
                riskLevel: 'low',
                doctorCheckQuestion: '是否需要皮肤科面诊评估痤疮严重度？',
                explanationForUser: '典型痤疮表现，与熬夜和压力相关。',
                evidenceRefs: [],
              },
              {
                name: '毛囊炎',
                likelihood: 'less_likely',
                supportEvidence: ['炎性丘疹表现'],
                againstEvidence: ['多发于面颊而非头皮/胸背', '无明确诱因'],
                missingInfo: ['皮疹是否伴有瘙痒或疼痛'],
                riskLevel: 'low',
                doctorCheckQuestion: '是否需要真菌镜检排除马拉色菌毛囊炎？',
                explanationForUser: '部分皮疹形态类似毛囊炎，但可能性较低。',
                evidenceRefs: [],
              },
            ],
            missingInfo: [],
            stageConclusion: '高度疑似寻常痤疮，建议日常护理配合观察。',
            canFinalAnswer: true,
            shouldAskUser: false,
            shouldSearchMore: true,
            shouldGenerateCarePlan: true,
          },
        },
      })

      const response = await runtime.run({
        userMessage: '最近脸上长了很多痘痘，尤其下巴和脸颊，熬夜后更严重。',
      })

      // 验证流程
      assert.notEqual(response.type, 'emergency', '痤疮不应急症输出')
      assert.notEqual(response.type, 'followup', '不应卡在风险核查追问')

      // 验证假设
      assert.ok(response.stateSnapshot.hypotheses.length >= 1, '应有至少1个假设')
      const hypoNames = response.stateSnapshot.hypotheses.map((h) => h.name).join(',')
      assert.ok(hypoNames.includes('痤疮'), '假设应包含痤疮，实际: ' + hypoNames)

      // 验证域
      assert.equal(response.stateSnapshot.primaryDomain, 'skin_mild', '应为皮肤轻症域')

      // 验证搜索
      if (search.calls.length > 0) {
        const queries = search.calls.map((c) => c.query).join(', ')
        assert.ok(queries.includes('痤疮') || queries.includes('acne'), '搜索词应包含痤疮相关')
      }
    },
  },
  {
    // v4.8：湿疹 — 多轮对话，用户补充信息后假设精化
    name: 'v4.8 湿疹-多轮对话 -> 首轮生成假设，补充信息后精化',
    run: async () => {
      const { runtime } = createRuntime({
        llm: {
          initial_hypothesis: {
            hypotheses: [
              {
                name: '湿疹/皮炎',
                likelihood: 'more_likely',
                supportEvidence: ['胳膊外侧红疹', '伴有瘙痒'],
                againstEvidence: [],
                missingInfo: ['持续时间', '是否接触过新物质'],
                riskLevel: 'low',
                doctorCheckQuestion: '',
                explanationForUser: '符合湿疹样皮炎表现。',
                evidenceRefs: [],
              },
              {
                name: '接触性皮炎',
                likelihood: 'possible',
                supportEvidence: ['局部发作'],
                againstEvidence: ['无明确新接触物'],
                missingInfo: ['是否有新护肤品/洗衣液/环境变化'],
                riskLevel: 'low',
                doctorCheckQuestion: '',
                explanationForUser: '需确认是否有新接触物。',
                evidenceRefs: [],
              },
            ],
            missingInfo: [
              { field: 'symptoms.duration', question: '持续多久了？', reason: '病程判断', priority: 'high' },
            ],
            stageConclusion: '初步判断为湿疹或接触性皮炎。',
            canFinalAnswer: false,
            shouldAskUser: true,
            shouldSearchMore: true,
            shouldGenerateCarePlan: false,
          },
        },
      })

      // Turn 1: 初始症状
      const first = await runtime.run({
        userMessage: '胳膊上长了一片红疹，很痒，好几天了还没消。',
      })

      assert.notEqual(first.type, 'emergency', '不应急症')
      assert.equal(first.stateSnapshot.primaryDomain, 'skin_mild', '应为皮肤轻症域')
      assert.ok(first.stateSnapshot.hypotheses.length >= 1, '应有假设')

      // Turn 2: 补充信息（模拟用户回答追问）
      const second = await runtime.run({
        caseId: first.caseId,
        userMessage: '大概一周了，没有接触过特别的东西。',
      })

      assert.notEqual(second.type, 'emergency', '第二轮不应急症')
      assert.ok(second.stateSnapshot.knownFacts.length > 0, '第二轮应有已知事实')
      assert.ok(second.stateSnapshot.hypotheses.length >= 1, '假设应保留')
    },
  },
  {
    // v4.9：皮肤 — 无 LLM 兜底（测试 fallback 路径的健壮性）
    name: 'v4.9 皮肤-无LLM兜底 -> 使用域种子降级，正常输出不崩溃',
    run: async () => {
      const { runtime } = createRuntime()
      // 不提供任何 LLM mock → 所有 LLM 走 fallback

      const response = await runtime.run({
        userMessage: '身上起了很多红疹，很痒，不知道是不是过敏。',
      })

      // 不应崩溃
      assert.notEqual(response.type, 'emergency', '不应急症')
      assert.equal(response.stateSnapshot.primaryDomain, 'skin_mild', '应为皮肤轻症域')
      // 即使没有 LLM，fallback 也应提供假设（域种子）
      assert.ok(response.stateSnapshot.hypotheses.length >= 1, 'fallback 应有假设')
      // 应有合理输出
      assert.ok(response.stateSnapshot.knownFacts.length > 0, '应有已知事实')
    },
  },

  // ===================================================================
  // 耳鼻喉科 (ENT) v4.10 - v4.12
  // ===================================================================

  {
    // v4.10：咽炎 — 典型流程，throat_respiratory 域完整支持
    name: 'v4.10 咽炎-完整流程 -> 假设生成、搜索、输出护理建议',
    run: async () => {
      const { runtime, search } = createRuntime({
        llm: {
          initial_hypothesis: {
            hypotheses: [
              {
                name: '急性咽炎',
                likelihood: 'more_likely',
                supportEvidence: ['咽痛', '吞咽时加重', '无发热'],
                againstEvidence: [],
                missingInfo: ['持续时间', '是否有鼻塞流涕'],
                riskLevel: 'low',
                doctorCheckQuestion: '',
                explanationForUser: '符合急性咽炎表现。',
                evidenceRefs: [],
              },
              {
                name: '扁桃体炎',
                likelihood: 'possible',
                supportEvidence: ['咽痛明显'],
                againstEvidence: ['无发热'],
                missingInfo: ['扁桃体是否肿大', '是否有脓点'],
                riskLevel: 'medium',
                doctorCheckQuestion: '需检查扁桃体情况。',
                explanationForUser: '部分扁桃体炎可不伴发热。',
                evidenceRefs: [],
              },
              {
                name: '胃食管反流相关咽部不适',
                likelihood: 'less_likely',
                supportEvidence: [],
                againstEvidence: ['无烧心反酸'],
                missingInfo: ['是否有反酸烧心'],
                riskLevel: 'low',
                doctorCheckQuestion: '',
                explanationForUser: '可能性较低。',
                evidenceRefs: [],
              },
            ],
            missingInfo: [],
            stageConclusion: '高度疑似急性咽炎，建议对症处理。',
            canFinalAnswer: true,
            shouldAskUser: false,
            shouldSearchMore: true,
            shouldGenerateCarePlan: true,
          },
        },
      })

      const response = await runtime.run({
        userMessage: '嗓子疼了两天了，咽东西的时候更疼，没有发烧。',
      })

      // 验证
      assert.notEqual(response.type, 'emergency', '咽炎不应急症')
      assert.notEqual(response.type, 'followup', '不应卡在风险核查追问')
      assert.equal(response.stateSnapshot.primaryDomain, 'throat_respiratory', '应为咽喉呼吸道域')

      // 假设
      assert.ok(response.stateSnapshot.hypotheses.length >= 1, '应有假设')
      const hypoNames = response.stateSnapshot.hypotheses.map((h) => h.name).join(',')
      assert.ok(hypoNames.includes('咽炎'), '假设应包含咽炎，实际: ' + hypoNames)

      // 搜索
      if (search.calls.length > 0) {
        const queries = search.calls.map((c) => c.query).join(', ')
        assert.ok(queries.includes('咽痛') || queries.includes('sore throat'), '搜索应包含咽痛相关')
      }
    },
  },
  {
    // v4.11：鼻炎 — 多轮对话，模拟用户逐步补充信息
    name: 'v4.11 鼻炎-多轮对话 -> 首轮假设生成，补充信息后推进',
    run: async () => {
      const { runtime } = createRuntime({
        llm: {
          initial_hypothesis: {
            hypotheses: [
              {
                name: '过敏性鼻炎',
                likelihood: 'more_likely',
                supportEvidence: ['鼻塞', '流清鼻涕'],
                againstEvidence: [],
                missingInfo: ['是否与季节/环境相关', '是否有打喷嚏'],
                riskLevel: 'low',
                doctorCheckQuestion: '',
                explanationForUser: '符合过敏性鼻炎表现。',
                evidenceRefs: [],
              },
              {
                name: '普通感冒',
                likelihood: 'possible',
                supportEvidence: ['鼻部症状'],
                againstEvidence: ['无发热', '无全身酸痛'],
                missingInfo: ['是否有咽痛', '病程进展'],
                riskLevel: 'low',
                doctorCheckQuestion: '',
                explanationForUser: '感冒可能性较低。',
                evidenceRefs: [],
              },
            ],
            missingInfo: [
              { field: 'symptoms.duration', question: '持续多久了？', reason: '病程判断', priority: 'high' },
            ],
            stageConclusion: '初步判断为过敏性鼻炎。',
            canFinalAnswer: false,
            shouldAskUser: true,
            shouldSearchMore: false,
            shouldGenerateCarePlan: false,
          },
        },
      })

      // Turn 1
      const first = await runtime.run({
        userMessage: '鼻子堵了好几天，一直流清鼻涕，不发烧。',
      })

      assert.notEqual(first.type, 'emergency', '不应急症')
      assert.equal(first.stateSnapshot.primaryDomain, 'throat_respiratory', '应为咽喉呼吸道域')
      assert.ok(first.stateSnapshot.hypotheses.length >= 1, '应有假设')

      // Turn 2: 补充信息
      const second = await runtime.run({
        caseId: first.caseId,
        userMessage: '每天早上起来打喷嚏，出门遇到冷空气也打。已经一周了。',
      })

      assert.notEqual(second.type, 'emergency', '第二轮不应急症')
      assert.ok(second.stateSnapshot.knownFacts.length > 0, '应有更多已知事实')

      // Turn 3: 最终确认
      const third = await runtime.run({
        caseId: first.caseId,
        userMessage: '没有其他不舒服，就是鼻子和眼睛有点痒。',
      })

      assert.notEqual(third.type, 'emergency', '第三轮不应急症')
      assert.ok(third.stateSnapshot.knownFacts.length > 0, '最终轮应有已知事实')
    },
  },
  {
    // v4.12：耳部不适 — 无对应症状域时系统的容错能力
    name: 'v4.12 耳部不适-未知域兜底 -> 不崩溃、不急诊化、输出阶段性判断',
    run: async () => {
      const { runtime } = createRuntime()
      // 不提供 LLM mock，耳朵症状无对应域 → unknown 域

      const response = await runtime.run({
        userMessage: '耳朵闷闷的，感觉听不太清楚，有点像坐飞机那种感觉。',
      })

      // 核心：不崩溃
      assert.notEqual(response.type, 'emergency', '不应急症')
      // 输出合理
      const text = JSON.stringify(response)
      assert.ok(text.length > 0, '应有输出')
    },
  },
"""

# Find insertion point: before "用药边界分析器单元测试"
marker = '  {\n    // 用药边界分析器单元测试'
if marker in content:
    content = content.replace(marker, new_tests + '\n' + marker, 1)
    print("Tests inserted successfully")
else:
    print("Marker not found, trying alternative...")
    idx = content.find('用药边界分析器单元测试')
    if idx >= 0:
        line_start = content.rfind('\n', 0, idx) + 1
        content = content[:line_start] + new_tests + '\n\n' + content[line_start:]
        print("Inserted via fallback")
    else:
        print("FAIL: marker not found")
        sys.exit(1)

with open('server/agent/agent.v3.test.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("OK: skin + ENT tests added (6 new tests)")
