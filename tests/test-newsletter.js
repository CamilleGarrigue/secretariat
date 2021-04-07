const nock = require('nock');
const rewire = require('rewire');
const chai = require('chai');
const sinon = require('sinon');
const HedgedocApi = require('hedgedoc-api');

const config = require('../config');
const knex = require('../db');
const BetaGouv = require('../betagouv');
const app = require('../index');
const controllerUtils = require('../controllers/utils');
const utils = require('./utils');
const { renderHtmlFromMd, getTitle } = require('../lib/mdtohtml');

const should = chai.should();

const {
  NUMBER_OF_DAY_IN_A_WEEK,
  NUMBER_OF_DAY_FROM_MONDAY,
  addDays,
  getMonday,
  formatDateToFrenchTextReadableFormat,
} = controllerUtils;
const {
  createNewsletter,
} = require('../schedulers/newsletterScheduler');

const NEWSLETTER_TITLE = '📰 Infolettre interne de la communauté beta.gouv.fr du __REMPLACER_PAR_DATE__';
const NEWSLETTER_TEMPLATE_CONTENT = `# ${NEWSLETTER_TITLE}
  Les nouvelles pourront être lu au point hebdomadaire (stand-up) le jeudi à 12h (pour rappel l'adresse du point hebdomadaire standup http://invites.standup.incubateur.net/ )
  Vous pouvez consulter cette infolettre [en ligne](__REMPLACER_PAR_LIEN_DU_PAD__).
  ### Modèle d'annonce d'une Startup (Présenté par Jeanne Doe)
  ## Nouveautés transverses
  *Documentation : [Comment lancer ou participer à un sujet transverse](https://doc.incubateur.net/communaute/travailler-a-beta-gouv/actions-transverses)*
  ## Annonces des recrutements
  ## :calendar: Evénements à venir
  ### 👋 Prochain point hebdomadaire (stand-up), jeudi __REMPLACER_PAR_DATE_STAND_UP__ à 12h
`;

const newsletterScheduler = rewire('../schedulers/newsletterScheduler');
const replaceMacroInContent = newsletterScheduler.__get__('replaceMacroInContent');
const computeMessageReminder = newsletterScheduler.__get__('computeMessageReminder');
const newsletterReminder = newsletterScheduler.__get__('newsletterReminder');
const sendNewsletterAndCreateNewOne = newsletterScheduler.__get__('sendNewsletterAndCreateNewOne');
const computeId = newsletterScheduler.__get__('computeId');

const mockNewsletters = [
  {
    year_week: '2020-52',
    validator: 'julien.dauphant',
    url: `${config.padURL}/45a5dsdsqsdada`,
    sent_at: new Date(),
  },
  {
    year_week: '2021-02',
    validator: 'julien.dauphant',
    url: `${config.padURL}/54564q5484saw`,
    sent_at: new Date(),
  },
  {
    year_week: '2021-03',
    validator: 'julien.dauphant',
    url: `${config.padURL}/5456dsadsahjww`,
    sent_at: new Date(),
  },
  {
    year_week: '2020-51',
    validator: 'julien.dauphant',
    url: `${config.padURL}/54564qwsajsghd4rhjww`,
    sent_at: new Date(),
  },
];

const mockNewsletter = {
  year_week: '2021-09',
  url: `${config.padURL}/rewir34984292342sad`,
};
const MOST_RECENT_NEWSLETTER_INDEX = 2;
describe('Newsletter', () => {
  describe('should get newsletter data for newsletter page', () => {
    beforeEach(async () => {
      await knex('newsletters').insert(mockNewsletters);
    });
    afterEach(async () => {
      await knex('newsletters').truncate();
    });

    it('should get previous newsletters and current newsletter', (done) => {
      const date = new Date('2021-01-20T07:59:59+01:00');
      this.clock = sinon.useFakeTimers(date);
      chai.request(app)
        .get('/newsletters')
        .set('Cookie', `token=${utils.getJWT('membre.actif')}`)
        .end((err, res) => {
          res.text.should.include(`${config.padURL}/5456dsadsahjww`);
          const allNewsletterButMostRecentOne = mockNewsletters.filter(
            (n) => n.year_week !== mockNewsletters[MOST_RECENT_NEWSLETTER_INDEX].year_week,
          );
          allNewsletterButMostRecentOne.forEach((newsletter) => {
            res.text.should.include(controllerUtils
              .formatDateToReadableDateAndTimeFormat(newsletter.sent_at));
          });
          const weekYear = mockNewsletters[MOST_RECENT_NEWSLETTER_INDEX].year_week.split('-');
          res.text.should.include(`<h3>Infolettre de la semaine du ${controllerUtils.formatDateToFrenchTextReadableFormat(controllerUtils.getDateOfISOWeek(weekYear[1], weekYear[0]))}</h3>`);
          this.clock.restore();
          done();
        });
    });
  });

  describe('cronjob newsletter', () => {
    beforeEach((done) => {
      this.slack = sinon.spy(BetaGouv, 'sendInfoToSlack');
      done();
    });

    afterEach((done) => {
      this.slack.restore();
      done();
    });

    it('should create new note', async () => {
      const createNewNoteWithContentAndAliasSpy = sinon.spy(HedgedocApi.prototype, 'createNewNoteWithContentAndAlias');
      const date = new Date('2021-03-04T07:59:59+01:00');
      const newsletterDate = addDays(date, 7);
      this.clock = sinon.useFakeTimers(date);
      const yearWeek = `${newsletterDate.getFullYear()}-${controllerUtils.getWeekNumber(newsletterDate)}`;
      const newsletterName = `infolettre-${yearWeek}-${computeId(yearWeek)}`;
      const padHeadCall = nock(`${config.padURL}`).persist()
      .head(/.*/)
      .reply(200, {
        status: 'OK',
      }, {
        'set-cookie': '73dajkhs8934892jdshakldsja',
      });

      const padPostLoginCall = nock(`${config.padURL}`).persist()
      .post(/^.*login.*/)
      .reply(200, {}, {
        'set-cookie': '73dajkhs8934892jdshakldsja',
      });

      const padGetDownloadCall = nock(`${config.padURL}`)
      .get(/^.*\/download/)
      .reply(200, NEWSLETTER_TEMPLATE_CONTENT);

      const padPostNewCall = nock(`${config.padURL}`)
      .post(/^.*new/)
      .reply(301, undefined, {
        Location: `${config.padURL}/${newsletterName}`,
      })
      .get(`/${newsletterName}`)
      .reply(200, '');

      const res = await createNewsletter();
      padHeadCall.isDone().should.be.true;
      padGetDownloadCall.isDone().should.be.true;
      padPostLoginCall.isDone().should.be.true;
      padPostNewCall.isDone().should.be.true;
      createNewNoteWithContentAndAliasSpy.firstCall.args[0].should.equal(
        replaceMacroInContent(NEWSLETTER_TEMPLATE_CONTENT, {
          __REMPLACER_PAR_LIEN_DU_PAD__: `${config.padURL}/${newsletterName}`,
          __REMPLACER_PAR_DATE_STAND_UP__: formatDateToFrenchTextReadableFormat(addDays(getMonday(newsletterDate),
            NUMBER_OF_DAY_IN_A_WEEK + NUMBER_OF_DAY_FROM_MONDAY.THURSDAY)),
          __REMPLACER_PAR_DATE__: controllerUtils.formatDateToFrenchTextReadableFormat(addDays(date, NUMBER_OF_DAY_IN_A_WEEK)),
        }),
      );
      const newsletter = await knex('newsletters').orderBy('year_week').first();
      newsletter.url.should.equal(`${config.padURL}/${newsletterName}`);
      this.clock.restore();
      newsletter.year_week.should.equal(yearWeek);
      await knex('newsletters').truncate();
    });

    it('should send remind on monday at 8am', async () => {
      await knex('newsletters').insert([mockNewsletter]);
      this.clock = sinon.useFakeTimers(new Date('2021-03-01T07:59:59+01:00'));
      await newsletterReminder('FIRST_REMINDER');
      this.slack.firstCall.args[0].should.equal(computeMessageReminder('FIRST_REMINDER', mockNewsletter));
      this.slack.restore();
      await knex('newsletters').truncate();
    });

    it('should send remind on thursday at 8am', async () => {
      await knex('newsletters').insert([mockNewsletter]);
      this.clock = sinon.useFakeTimers(new Date('2021-03-04T07:59:59+01:00'));
      await newsletterReminder('SECOND_REMINDER');
      this.slack.firstCall.args[0].should.equal(computeMessageReminder('SECOND_REMINDER', mockNewsletter));
      this.clock.restore();
      this.slack.restore();
      await knex('newsletters').truncate();
    });

    it('should send remind on thursday at 6pm', async () => {
      await knex('newsletters').insert([mockNewsletter]);
      this.clock = sinon.useFakeTimers(new Date('2021-03-04T17:59:59+01:00'));
      await newsletterReminder('THIRD_REMINDER');
      this.slack.firstCall.args[0].should.equal(computeMessageReminder('THIRD_REMINDER', mockNewsletter));
      this.clock.restore();
      this.slack.restore();
      await knex('newsletters').truncate();
    });

    it('should send remind on friday at 8am', async () => {
      this.clock = sinon.useFakeTimers(new Date('2021-03-05T07:59:59+01:00'));
      await newsletterReminder('THIRD_REMINDER');
      this.slack.notCalled.should.be.true;
      this.clock.restore();
      this.slack.restore();
    });

    it('should send newsletter if validated', async () => {
      const date = new Date('2021-03-05T07:59:59+01:00');
      const dateAsString = controllerUtils.formatDateToFrenchTextReadableFormat(
        addDays(date, NUMBER_OF_DAY_IN_A_WEEK),
      );
      const contentWithMacro = replaceMacroInContent(NEWSLETTER_TEMPLATE_CONTENT, {
        __REMPLACER_PAR_LIEN_DU_PAD__: `${config.padURL}/jfkdsfljkslfsfs`,
        __REMPLACER_PAR_DATE_STAND_UP__: formatDateToFrenchTextReadableFormat(
          addDays(getMonday(date),
            NUMBER_OF_DAY_IN_A_WEEK + NUMBER_OF_DAY_FROM_MONDAY.THURSDAY),
        ),
        __REMPLACER_PAR_DATE__: dateAsString,
      });
      const padHeadCall = nock(`${config.padURL}`).persist()
      .head(/.*/)
      .reply(200, {
        status: 'OK',
      }, {
        'set-cookie': '73dajkhs8934892jdshakldsja',
      });

      const padPostLoginCall = nock(`${config.padURL}`).persist()
      .post(/^.*login.*/)
      .reply(200, {}, {
        'set-cookie': '73dajkhs8934892jdshakldsja',
      });

      const padGetDownloadCall = nock(`${config.padURL}`)
      .get(/^.*\/download/)
      .reply(200, contentWithMacro).persist();

      const padPostNewCall = nock(`${config.padURL}`)
      .post(/^.*new/)
      .reply(200, '');

      await knex('newsletters').insert([{
        ...mockNewsletter,
        validator: 'julien.dauphant',
        sent_at: null,
      }]);
      const sendEmailStub = sinon.stub(controllerUtils, 'sendMail').returns(true);
      this.clock = sinon.useFakeTimers(date);
      await sendNewsletterAndCreateNewOne();
      padHeadCall.isDone().should.be.true;
      padGetDownloadCall.isDone().should.be.true;
      padPostLoginCall.isDone().should.be.true;
      padPostNewCall.isDone().should.be.true;
      sendEmailStub.calledOnce.should.be.true;
      sendEmailStub.firstCall.args[1].should.equal(replaceMacroInContent(
        NEWSLETTER_TITLE, {
          __REMPLACER_PAR_DATE__: dateAsString,
        },
      ));
      sendEmailStub.firstCall.args[2].should.equal(renderHtmlFromMd(contentWithMacro));
      this.slack.called.should.be.true;
      const newsletter = await knex('newsletters').where({
        year_week: `${date.getFullYear()}-${controllerUtils.getWeekNumber(date)}`,
      }).whereNotNull('sent_at').first();
      newsletter.sent_at.should.not.be.null;
      this.clock.restore();
      sendEmailStub.restore();
      this.slack.restore();
      await knex('newsletters').truncate();
    });

    it('should not send newsletter if not validated', async () => {
      const padHeadCall = nock(`${config.padURL}`).persist()
      .head(/.*/)
      .reply(200, {
        status: 'OK',
      }, {
        'set-cookie': '73dajkhs8934892jdshakldsja',
      });

      const padPostLoginCall = nock(`${config.padURL}`).persist()
      .post(/^.*login.*/)
      .reply(200, {}, {
        'set-cookie': '73dajkhs8934892jdshakldsja',
      });

      const padGetDownloadCall = nock(`${config.padURL}`)
      .get(/^.*\/download/)
      .reply(200, NEWSLETTER_TEMPLATE_CONTENT);

      await knex('newsletters').insert([{
        ...mockNewsletter,
      }]);
      const date = new Date('2021-03-05T07:59:59+01:00');
      const sendEmailStub = sinon.stub(controllerUtils, 'sendMail').returns(true);
      this.clock = sinon.useFakeTimers(date);
      await sendNewsletterAndCreateNewOne();
      padHeadCall.isDone().should.be.false;
      padGetDownloadCall.isDone().should.be.false;
      padPostLoginCall.isDone().should.be.false;
      sendEmailStub.calledOnce.should.be.false;
      this.slack.notCalled.should.be.true;
      this.clock.restore();
      sendEmailStub.restore();
      this.slack.restore();
      await knex('newsletters').truncate();
    });
  });

  describe('newsletter interface', () => {
    it('should validate newsletter', async () => {
      await knex('newsletters').insert([{
        ...mockNewsletter,
      }]);
      const date = new Date('2021-03-05T07:59:59+01:00');
      this.clock = sinon.useFakeTimers(date);
      const res = await chai.request(app)
        .get('/validateNewsletter')
        .set('Cookie', `token=${utils.getJWT('membre.actif')}`);
      const newsletter = await knex('newsletters').where({ year_week: mockNewsletter.year_week }).first();
      newsletter.validator.should.equal('membre.actif');
      await knex('newsletters').truncate();
      this.clock.restore();
    });

    it('should cancel newsletter', async () => {
      await knex('newsletters').insert([{
        ...mockNewsletter,
        validator: 'membre.actif',
      }]);
      const date = new Date('2021-03-05T07:59:59+01:00');
      this.clock = sinon.useFakeTimers(date);
      const res = await chai.request(app)
        .get('/cancelNewsletter')
        .set('Cookie', `token=${utils.getJWT('membre.actif')}`);
      const newsletter = await knex('newsletters').where({ year_week: mockNewsletter.year_week }).first();
      should.equal(newsletter.validator, null);
      await knex('newsletters').truncate();
      this.clock.restore();
    });
  });
});