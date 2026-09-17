// guide.js -- optional first-run help for people who have never tracked food.
// The invitation is quiet, appears once, and never blocks logging. The full guide
// remains available from Settings after either completion or dismissal.

const EATIFY_GUIDE_KEY = 'ledger_guide_v1';
const EATIFY_GUIDE_STEPS = [
  {
    kicker:'Start here',
    title:'Pick a direction, not perfect numbers',
    copy:'In <strong>Settings → Goal & corridor</strong>, choose <strong>cut</strong> to lose weight, <strong>maintain</strong> to stay around the same weight, or <strong>lean bulk</strong> to gain slowly. Eatify turns that into a calorie range. The starting estimate can be imperfect—it improves from your own logs and weigh-ins.',
    rule:'A corridor is a useful range, not a daily pass-or-fail score.'
  },
  {
    kicker:'Daily habit',
    title:'Log the meal you actually ate',
    copy:'Use the box at the bottom and describe it normally—“chicken pulao and raita”—or use a photo. Check the result before saving. Weigh portions when convenient; a reasonable estimate is still more useful than skipping the meal completely.',
    rule:'Consistency beats fake precision.'
  },
  {
    kicker:'What to watch',
    title:'Start with calories and protein',
    copy:'The calorie corridor manages the direction of your weight. The protein floor helps you stay full and retain muscle. Carbs, fats, and micronutrients are useful detail, but you do not need to optimise everything on day one.',
    rule:'Land near the calorie corridor and try to clear the protein floor.'
  },
  {
    kicker:'What progress means',
    title:'Judge weeks, not one morning',
    copy:'Body weight moves with water, salt, digestion, and sleep. Add a morning weight under <strong>Logs</strong> a few times each week, under similar conditions. Eatify uses the trend; one unusual reading does not mean the diet stopped working.',
    rule:'Change the plan from a trend, not from one noisy day.'
  },
  {
    kicker:'Make it easy',
    title:'Your regular meals become shortcuts',
    copy:'Previously logged meals stay in <strong>Offline meals</strong>. Pin favourites as usuals, then log them without internet and adjust only the serving size. Signing in keeps the same history and settings on your other devices.',
    rule:'The app should need less effort the longer you use it.'
  }
];

function hideEatifyGuideInvite(state){
  const card=document.getElementById('guideInvite');
  if(card)card.hidden=true;
  if(state)setKey(EATIFY_GUIDE_KEY,state);
}

function maybeOfferEatifyGuide(){
  const card=document.getElementById('guideInvite');
  if(!card||getKey(EATIFY_GUIDE_KEY))return;
  card.hidden=false;
}

function startEatifyGuide(startAt){
  hideEatifyGuideInvite();
  let at=Math.max(0,Math.min(EATIFY_GUIDE_STEPS.length-1,+startAt||0));
  return openSheet((sheet,close)=>{
    sheet.classList.add('guide-sheet');
    const progress=document.createElement('div'); progress.className='guide-progress';
    const kicker=document.createElement('div'); kicker.className='guide-kicker';
    const title=document.createElement('h2');
    const copy=document.createElement('div'); copy.className='guide-copy';
    const rule=document.createElement('div'); rule.className='guide-rule';
    const actions=document.createElement('div'); actions.className='footer-actions';
    const back=document.createElement('button'); back.type='button'; back.className='ghost'; back.textContent='Back';
    const next=document.createElement('button'); next.type='button';
    actions.append(back,next); sheet.append(progress,kicker,title,copy,rule,actions);
    const draw=()=>{
      const step=EATIFY_GUIDE_STEPS[at];
      progress.innerHTML=EATIFY_GUIDE_STEPS.map((_,i)=>`<span class="${i<=at?'on':''}"></span>`).join('');
      kicker.textContent=`${step.kicker} · ${at+1} of ${EATIFY_GUIDE_STEPS.length}`;
      title.textContent=step.title; copy.innerHTML=step.copy; rule.textContent=step.rule;
      back.hidden=at===0; next.textContent=at===EATIFY_GUIDE_STEPS.length-1?'Got it':'Next';
    };
    back.onclick=()=>{if(at>0){at--;draw();}};
    next.onclick=()=>{
      if(at<EATIFY_GUIDE_STEPS.length-1){at++;draw();return;}
      setKey(EATIFY_GUIDE_KEY,'complete'); close(true); toast('Walkthrough complete · reopen it from Settings anytime');
    };
    draw(); return next;
  });
}

document.getElementById('guideStart').onclick=()=>startEatifyGuide();
document.getElementById('guideDismiss').onclick=()=>hideEatifyGuideInvite('dismissed');
