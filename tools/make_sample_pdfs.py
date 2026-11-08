"""Generate two small ORIGINAL sample textbooks for testing ingestion and lessons.

    python3 tools/make_sample_pdfs.py  ->  samples/sample-medicine.pdf, samples/sample-exam.pdf

The text is written for testing only; it is not a clinical reference.
"""
import os
import pymupdf as fitz

OUT = os.path.join(os.path.dirname(__file__), '..', 'samples')
os.makedirs(OUT, exist_ok=True)

P = lambda *xs: ''.join(f'<p>{x}</p>' for x in xs)

MED = [
  ('h1', 'Chapter 12  Dizziness and Vertigo'),
  ('p', P(
    'Dizziness is one of the most common reasons patients seek care, and the first task is to decide what the patient means by the word. '
    'Vertigo is an illusion of movement, usually rotation, of the self or of the surroundings. It points to an asymmetry of input from the vestibular system, '
    'either in the inner ear or in its central connections. Other forms of dizziness, such as presyncope or disequilibrium, have different causes and are approached differently.',
    'A careful history separates episodic from continuous symptoms and identifies triggers. Episodes lasting seconds and provoked by changes in head position '
    'suggest benign paroxysmal positional vertigo, whereas a single prolonged episode with nausea and imbalance raises the question of vestibular neuritis or a posterior circulation stroke.')),
  ('h2', 'Benign Paroxysmal Positional Vertigo'),
  ('p', P(
    'Benign paroxysmal positional vertigo (BPPV) is the most common cause of vertigo of peripheral origin. Patients describe brief spells of spinning, lasting less than a minute, '
    'brought on by lying down, rolling over in bed, or looking up. Between spells the patient feels well, although some report a vague imbalance.',
    'The disorder is caused by fragments of otoconia that have become detached from the utricle and drift into one of the semicircular canals, most often the posterior canal. '
    'When the head moves in the plane of the affected canal, the debris moves under gravity and drags the endolymph, deflecting the cupula and producing vertigo and nystagmus. '
    'This mechanism, called canalithiasis, explains the latency of a few seconds, the short duration and the fatigability of the response (see Fig. 12-1).')),
  ('img', 'Figure 12-1  The posterior semicircular canal with free-floating otoconial debris (canalithiasis). Head movement in the plane of the canal moves the debris and deflects the cupula.'),
  ('h3', 'Diagnosis'),
  ('p', P(
    'The diagnosis of posterior canal BPPV is confirmed with the Dix-Hallpike test. A positive test reproduces the vertigo and produces a burst of upbeating, torsional nystagmus '
    'with the upper pole of the eye beating toward the lower ear. The nystagmus begins after a latency of a few seconds, lasts less than a minute, and reverses direction when the patient sits up. '
    'Imaging is not required when the history and examination are typical.',
    'Features that suggest a central cause include nystagmus without latency, purely vertical downbeating nystagmus, nystagmus that does not fatigue, and associated neurologic signs. '
    'These patients need further evaluation (Table 12-1).')),
  ('table', ('Table 12-1  Peripheral versus central positional nystagmus',
             [('Feature', 'Peripheral (BPPV)', 'Central'), ('Latency', '2–10 s', 'None'), ('Duration', '< 60 s', 'Persistent'),
              ('Fatigue', 'Yes', 'No'), ('Direction', 'Upbeat-torsional', 'Often pure downbeat'), ('Other signs', 'None', 'Often present')])),
  ('h3', 'Treatment'),
  ('p', P(
    'Posterior canal BPPV is treated with a canalith repositioning procedure, of which the Epley maneuver is the most widely used. The aim is to move the debris out of the posterior canal '
    'and back into the utricle, where it no longer causes symptoms. A single maneuver relieves symptoms in most patients, and it may be repeated at the same visit if nystagmus persists.',
    'The Epley maneuver begins in the Dix-Hallpike position with the affected ear down. After the nystagmus settles, the head is turned 90 degrees toward the unaffected side and held for about thirty seconds. '
    'The patient then rolls onto the shoulder of the unaffected side so that the face points toward the floor, and finally sits up slowly with the chin tucked. '
    'Each position is held until any induced nystagmus has stopped.',
    'Vestibular suppressant drugs do not treat the cause and may slow central compensation; they have little role beyond short-term relief of nausea. '
    'Recurrence is common, occurring in roughly a third of patients within a few years, and patients can be taught to perform the maneuver at home.')),
  ('h2', 'Vestibular Neuritis'),
  ('p', P(
    'Vestibular neuritis presents with the acute onset of severe, continuous vertigo, nausea, vomiting and gait instability, without hearing loss. It is thought to be due to a viral or post-viral '
    'inflammation of the vestibular nerve. Examination shows spontaneous horizontal nystagmus beating away from the affected side and an abnormal head impulse test toward the affected side.',
    'Symptoms improve over days as central compensation develops. Early mobilisation and vestibular rehabilitation speed recovery. A short course of corticosteroids is sometimes given, although its benefit is debated.')),
  ('h1', 'Chapter 18  Heart Failure'),
  ('p', P(
    'Heart failure is a clinical syndrome in which the heart is unable to pump blood at a rate that meets the needs of the tissues, or can do so only at elevated filling pressures. '
    'It is the final common pathway of many cardiac diseases, most often coronary artery disease, hypertension and cardiomyopathy.',
    'Heart failure is classified by the left ventricular ejection fraction into heart failure with reduced ejection fraction, heart failure with mildly reduced ejection fraction, '
    'and heart failure with preserved ejection fraction. The distinction matters because the evidence for drug therapy differs between these groups.')),
  ('h2', 'Pathophysiology'),
  ('p', P(
    'When cardiac output falls, compensatory mechanisms are activated. The sympathetic nervous system increases heart rate and contractility, and the renin-angiotensin-aldosterone system '
    'promotes salt and water retention and vasoconstriction. In the short term these responses maintain perfusion, but sustained activation is harmful: it increases afterload, '
    'promotes myocardial fibrosis and drives progressive remodelling of the ventricle.',
    'Natriuretic peptides are released from the stretched myocardium and partly counteract these effects by promoting natriuresis and vasodilation. Their measurement is useful in diagnosis.')),
  ('h2', 'Clinical Manifestations'),
  ('p', P(
    'The cardinal symptoms are breathlessness, fatigue and fluid retention. Dyspnea occurs first on exertion and later at rest; orthopnea and paroxysmal nocturnal dyspnea reflect pulmonary venous congestion. '
    'Examination may show tachycardia, raised jugular venous pressure, a third heart sound, pulmonary crackles, hepatomegaly and peripheral edema.')),
  ('h2', 'Diagnosis'),
  ('p', P(
    'The diagnosis rests on symptoms and signs supported by objective evidence of cardiac dysfunction. An elevated natriuretic peptide level supports the diagnosis, and a normal level makes it unlikely in an untreated patient. '
    'Echocardiography is the key investigation: it measures the ejection fraction, assesses valves and wall motion, and estimates filling pressures. '
    'An electrocardiogram and chest radiograph are obtained in all patients.')),
  ('h2', 'Treatment'),
  ('p', P(
    'Treatment aims to relieve symptoms, prevent hospital admission and prolong survival. Loop diuretics relieve congestion but do not improve survival. '
    'In heart failure with reduced ejection fraction, four classes of drugs reduce mortality: an angiotensin receptor-neprilysin inhibitor or ACE inhibitor, a beta blocker, '
    'a mineralocorticoid receptor antagonist and an SGLT2 inhibitor. These are started early and titrated to target doses as tolerated.',
    'Device therapy has a role in selected patients. An implantable cardioverter-defibrillator reduces sudden death in patients with a persistently low ejection fraction, '
    'and cardiac resynchronisation therapy benefits patients with a wide QRS complex.')),
  ('h1', 'Chapter 25  Gout'),
  ('p', P(
    'Gout is an inflammatory arthritis caused by the deposition of monosodium urate crystals in and around joints. It is associated with hyperuricemia, '
    'although many people with high urate levels never develop gout. The first attack typically affects the first metatarsophalangeal joint, which becomes hot, red, swollen and exquisitely tender.',
    'The diagnosis is confirmed by finding negatively birefringent needle-shaped crystals in synovial fluid. Acute attacks are treated with colchicine, a nonsteroidal anti-inflammatory drug or a corticosteroid, '
    'and long-term urate-lowering therapy with allopurinol is offered to patients with recurrent attacks or tophi.')),
]

EXAM = [
  ('h1', 'Chapter 7  The Ear and Vestibular Examination'),
  ('p', P(
    'Examination of the dizzy patient begins with observation of gait and the eyes at rest. Look for spontaneous nystagmus in primary gaze and on lateral gaze before any provocative maneuver is performed.')),
  ('h2', 'The Dix-Hallpike Maneuver'),
  ('p', P(
    'Explain the test to the patient first, warning that it may briefly provoke dizziness. Ask about neck and back problems, because the maneuver requires neck extension and rotation.',
    'Seat the patient on the examination couch so that, when lying back, the head will extend over the end of the couch. Turn the head 45 degrees toward the side being tested. '
    'Holding the head firmly, lower the patient quickly into the supine position with the neck extended about 20 degrees below the horizontal. '
    'Keep the eyes open and watch them closely for at least thirty seconds.',
    'A positive test produces vertigo together with torsional, upbeating nystagmus after a short latency. Return the patient slowly to the sitting position, watch for reversal of the nystagmus, and then repeat the test on the other side.',
    'The test works because placing the head in this position brings the posterior semicircular canal of the lower ear into the vertical plane, so that any loose otoconia fall under gravity and stimulate the canal.')),
  ('h2', 'The Head Impulse Test'),
  ('p', P(
    'Ask the patient to fix their gaze on your nose. Hold the head and turn it rapidly through about 15 degrees to one side. A normal vestibulo-ocular reflex keeps the eyes on target. '
    'A corrective saccade back to the target indicates a peripheral vestibular lesion on the side toward which the head was turned.')),
  ('h1', 'Chapter 9  The Cardiovascular Examination'),
  ('p', P(
    'Begin with the general inspection, the hands and the pulse. Measure the jugular venous pressure with the patient reclining at 45 degrees and the head turned slightly to the left.',
    'Palpate the apex beat and then auscultate in the four classic areas with the diaphragm and bell. A third heart sound is a low-pitched sound heard early in diastole and in adults usually indicates ventricular failure.')),
]


def make_figure_png(path):
    doc = fitz.open()
    page = doc.new_page(width=420, height=260)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1))
    page.draw_oval(fitz.Rect(90, 40, 330, 220), color=(0.2, 0.3, 0.5), width=10)
    for i, (x, y) in enumerate([(120, 170), (135, 185), (150, 192), (128, 160)]):
        page.draw_circle((x, y), 6, color=(0.55, 0.2, 0.1), fill=(0.55, 0.2, 0.1))
    page.draw_rect(fitz.Rect(300, 105, 345, 155), color=(0.1, 0.1, 0.1), fill=(0.85, 0.85, 0.85))
    page.insert_text((300, 175), 'cupula', fontsize=12)
    page.insert_text((60, 240), 'otoconia', fontsize=12)
    page.get_pixmap(matrix=fitz.Matrix(2, 2)).save(path)


def build(blocks, title, two_col, outname):
    css = 'body{font-family:serif;font-size:10pt;} p{margin-bottom:6pt;text-align:justify;} ' \
          'h1{font-size:18pt;font-weight:bold;margin-bottom:10pt;} h2{font-size:13pt;font-weight:bold;margin-top:8pt;} ' \
          'h3{font-size:10pt;font-weight:bold;margin-top:6pt;} .cap{font-size:8.5pt;font-family:sans-serif;} ' \
          'td{font-size:8.5pt;font-family:sans-serif;padding:2pt;} table{margin-bottom:8pt;}'
    html = ''
    for kind, val in blocks:
        if kind in ('h1', 'h2', 'h3'):
            html += f'<{kind}>{val}</{kind}>'
        elif kind == 'p':
            html += val
        elif kind == 'img':
            html += f'<img src="fig.png" width="220"/><p class="cap"><b>{val.split("  ")[0]}</b>  {val.split("  ",1)[1]}</p>'
        elif kind == 'table':
            cap, rows = val
            html += f'<p class="cap"><b>{cap.split("  ")[0]}</b>  {cap.split("  ",1)[1]}</p><table>' + ''.join(
                '<tr>' + ''.join(f'<td>{c}</td>' for c in r) + '</tr>' for r in rows) + '</table>'
    figdir = os.path.join(OUT, '_tmp'); os.makedirs(figdir, exist_ok=True)
    make_figure_png(os.path.join(figdir, 'fig.png'))
    story = fitz.Story(html=html, user_css=css, archive=fitz.Archive(figdir))
    W, H = 595, 842
    if two_col:
        rects = [fitz.Rect(50, 70, 290, 790), fitz.Rect(305, 70, 545, 790)]
    else:
        rects = [fitz.Rect(70, 70, 525, 790)]
    writer = fitz.DocumentWriter(os.path.join(OUT, '_raw.pdf'))
    more, i = 1, 0
    while more:
        if i % len(rects) == 0:
            dev = writer.begin_page(fitz.Rect(0, 0, W, H))
        more, _ = story.place(rects[i % len(rects)])
        story.draw(dev)
        if i % len(rects) == len(rects) - 1 or not more:
            writer.end_page()
        i += 1
    writer.close()
    doc = fitz.open(os.path.join(OUT, '_raw.pdf'))
    # Running header + page numbers, and an outline (TOC) like real textbooks.
    toc = []
    for pno, page in enumerate(doc):
        page.insert_text((50, 40), title.upper(), fontsize=7, fontname='helv', color=(0.4, 0.4, 0.4))
        page.insert_text((W / 2 - 5, 815), str(pno + 1), fontsize=8, fontname='helv')
        for kind, val in blocks:
            if kind in ('h1', 'h2') and page.search_for(val.split('  ')[-1][:40]):
                if not any(t[1] == val for t in toc):
                    toc.append([1 if kind == 'h1' else 2, val, pno + 1])
    doc.set_toc(toc)
    doc.save(os.path.join(OUT, outname))
    os.remove(os.path.join(OUT, '_raw.pdf'))
    print(outname, len(doc), 'pages', len(toc), 'toc entries')


build(MED, 'Sample Textbook of Medicine', True, 'sample-medicine.pdf')
build(EXAM, 'Sample Guide to Physical Examination', False, 'sample-exam.pdf')
